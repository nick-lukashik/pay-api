import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { and, asc, count, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { paymentSucceededEvent } from '../checkout/payments.service.js'
import { DB } from '../common/database/database.js'
import { OutboxRelay } from '../common/messaging/outbox-relay.js'
import { eventsExchange } from '../common/messaging/topology.js'
import { Metrics } from '../common/metrics/metrics.js'
import { reconciliationConfig } from '../config/config.js'
import { outbox, payments } from '../db/schema.js'
import type { Db, PaymentRow, Tx } from '../db/types.js'
import { WalletClient } from './wallet-client.js'

/** How long a payment's event may take to reach the ledger before it counts as lost. */
const GRACE = sql`interval '5 minutes'`
const BATCH_SIZE = 200

const RESULTS = [
    'ok',
    'republished',
    'error',
] as const

const isDue = () =>
    and(eq(payments.status, 'succeeded'), isNull(payments.reconciledAt), lt(payments.paidAt, sql`now() - ${GRACE}`))

/** The ref under which wallet-api posts a payment's pack. */
const packRef = (paymentId: string) => `pack:payment:${paymentId}`

/**
 * Every paid payment ends up in the ledger. A round asks wallet-api about each
 * succeeded payment past the grace period that is not reconciled yet: a pack in
 * the ledger marks the payment reconciled, a missing one sends its event again
 * through the outbox, and the next round looks again. wallet-api unavailable:
 * nothing changes, the next round tries again. A pod runs a round when it
 * starts, then on an interval; the advisory lock keeps it to one pod at a time.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly logger = new Logger('Reconciliation')
    private timer: NodeJS.Timeout | undefined
    private running: Promise<void> | undefined
    private stopped = false
    private readonly intervalMs: number
    private readonly results

    constructor(
        @Inject(DB) private readonly db: Db,
        @Inject(reconciliationConfig.KEY) config: ConfigType<typeof reconciliationConfig>,
        private readonly wallet: WalletClient,
        private readonly relay: OutboxRelay,
        metrics: Metrics,
    ) {
        this.intervalMs = config.intervalMs
        this.results = metrics.counter({
            name: 'payment_reconciliation_total',
            help: 'Reconciliation by result: ok (a payment found in the ledger), republished (a payment missing from it, its event sent again), error (a batch that failed, usually wallet-api not answering; nothing changed).',
            labelNames: [
                'result',
            ],
        })
        // Every series from the start, so rate() and alerts see zero rather than nothing.
        for (const result of RESULTS)
            this.results.inc(
                {
                    result,
                },
                0,
            )
        const database = this.db
        metrics.gauge({
            name: 'payments_unreconciled',
            help: 'Succeeded payments past the grace period not yet seen in the ledger; NaN when unknown.',
            async collect() {
                const unreconciled = await database
                    .select({
                        total: count(),
                    })
                    .from(payments)
                    .where(isDue())
                    .then(
                        ([row]) => row?.total ?? 0,
                        () => Number.NaN,
                    )
                this.set(unreconciled)
            },
        })
    }

    onApplicationBootstrap() {
        this.schedule(0)
    }

    async beforeApplicationShutdown() {
        this.stopped = true
        clearTimeout(this.timer)
        await this.running
    }

    private schedule(delay: number) {
        if (this.stopped || this.intervalMs === 0) return
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            void this.round()
        }, delay)
    }

    /** One pass over every due payment; a failure ends it, and the next round starts over. */
    round(): Promise<void> {
        this.running ??= this.pass().finally(() => {
            this.running = undefined
        })
        return this.running
    }

    private async pass() {
        try {
            let after: string | undefined
            do {
                after = await this.batch(after)
            } while (after && !this.stopped)
        } catch (error) {
            this.results.inc({
                result: 'error',
            })
            this.logger.warn(
                {
                    err: (error as Error).message,
                },
                'Reconciliation failed, the next round tries again',
            )
        } finally {
            this.schedule(this.intervalMs)
        }
    }

    /** One batch in one transaction; returns where the next one starts, undefined when this was the last. */
    private async batch(after: string | undefined) {
        const outcome = await this.db.transaction(async tx => {
            const locked = await tx.execute<{
                locked: boolean
            }>(sql`select pg_try_advisory_xact_lock(hashtextextended('pay-api:reconciliation', 0)) as locked`)
            if (!locked.rows[0]?.locked) return undefined
            const due = await tx
                .select()
                .from(payments)
                .where(and(isDue(), after ? gt(payments.id, after) : undefined))
                .orderBy(asc(payments.id))
                .limit(BATCH_SIZE)
            if (due.length === 0) return undefined
            const known = await this.wallet.knownRefs(due.map(payment => packRef(payment.id)))

            const reconciled = due.filter(payment => known.has(packRef(payment.id))).map(payment => payment.id)
            if (reconciled.length > 0)
                await tx
                    .update(payments)
                    .set({
                        reconciledAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .where(inArray(payments.id, reconciled))
            const republished: string[] = []
            for (const payment of due) {
                if (!known.has(packRef(payment.id)) && (await this.republish(tx, payment))) republished.push(payment.id)
            }
            return {
                reconciled,
                republished,
                last: due.length === BATCH_SIZE ? due.at(-1)?.id : undefined,
            }
        })
        if (!outcome) return undefined
        this.results.inc(
            {
                result: 'ok',
            },
            outcome.reconciled.length,
        )
        if (outcome.republished.length > 0) {
            this.results.inc(
                {
                    result: 'republished',
                },
                outcome.republished.length,
            )
            this.logger.warn(
                {
                    paymentIds: outcome.republished,
                },
                'Paid but not in the ledger: event sent again',
            )
            this.relay.kick()
        }
        return outcome.last
    }

    /**
     * Sends the payment's event again: a new outbox row when the old one was
     * purged, otherwise the same row back to pending, unless it is still on its
     * way (not published yet, or published within the grace period). False then.
     */
    private async republish(tx: Tx, payment: PaymentRow) {
        if (!payment.paidAt) throw new Error(`succeeded payment ${payment.id} has no paid_at`)
        const event = paymentSucceededEvent(payment, payment.paidAt)
        const sent = await tx
            .insert(outbox)
            .values({
                eventId: event.eventId,
                type: event.type,
                exchange: eventsExchange(event.producer),
                envelope: event,
            })
            .onConflictDoUpdate({
                target: outbox.eventId,
                set: {
                    status: 'pending',
                    attempts: 0,
                    leaseToken: null,
                    leaseUntil: null,
                    availableAt: sql`now()`,
                    lastError: null,
                    createdAt: sql`now()`,
                    publishedAt: null,
                },
                where: and(eq(outbox.status, 'published'), lt(outbox.publishedAt, sql`now() - ${GRACE}`)),
            })
            .returning({
                eventId: outbox.eventId,
            })
        return sent.length === 1
    }
}
