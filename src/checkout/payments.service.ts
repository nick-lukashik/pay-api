import { createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { type Currency, paymentSucceededV1 } from '@nick-lukashik/contracts'
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { productByKey } from '../catalog/catalog.js'
import { DB, isUniqueViolation } from '../common/database/database.js'
import { AppError, notFound } from '../common/http/app-error.js'
import { cursorCodec } from '../common/http/cursor.js'
import { defineEvent } from '../common/messaging/event.js'
import { enqueueEvent } from '../common/messaging/outbox.js'
import { OutboxRelay } from '../common/messaging/outbox-relay.js'
import { payments, webhookEvents } from '../db/schema.js'
import type { Db, PaymentRow, Tx, WebhookEventRow } from '../db/types.js'
import { toMinorUnits } from '../providers/money.js'
import {
    CheckoutRefused,
    type FoundCheckout,
    type ParsedWebhook,
    PaymentProvider,
    type ProviderFact,
} from '../providers/provider.js'
import { WebhookMetrics, type WebhookResult } from '../webhooks/webhook-metrics.js'
import { IdClient } from './id-client.js'

export const paymentSucceeded = defineEvent(
    paymentSucceededV1.type,
    paymentSucceededV1.producer,
    paymentSucceededV1.payload,
)

const cursor = cursorCodec(
    z.object({
        createdAt: z.iso.datetime(),
        id: z.uuid(),
    }),
)

/**
 * How long one executor owns a payment's checkout: longer than its provider
 * calls take (each bounded by the adapter's timeout, Lava 10 s), so a live
 * executor keeps it and a crashed one frees it.
 */
const CHECKOUT_LEASE = sql`interval '30 seconds'`

/** The order snapshot in minor units; the catalog's prices always parse. */
const snapshotMinor = (payment: PaymentRow) => {
    const minor = toMinorUnits(payment.amount, payment.currency)
    if (minor === undefined) throw new Error(`payment ${payment.id} has a malformed amount`)
    return minor
}

export type FactOutcome = 'processed' | 'ignored' | 'unmatched' | 'mismatch'

const resultOf = (outcome: FactOutcome): WebhookResult =>
    outcome === 'processed' ? 'applied' : outcome === 'ignored' ? 'duplicate' : outcome

/** The fact of a recorded webhook, as it was verified on receipt. */
const factOf = (event: WebhookEventRow): ProviderFact => {
    if (!event.providerPaymentId || !event.paymentStatus) throw new Error(`webhook event ${event.id} has no fact`)
    return {
        providerPaymentId: event.providerPaymentId,
        outcome: event.paymentStatus,
        amountMinor: event.amountMinor ?? undefined,
        currency: event.currency ?? undefined,
        dedupeKey: event.dedupeKey,
    }
}

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger('Payments')

    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly provider: PaymentProvider,
        private readonly users: IdClient,
        private readonly relay: OutboxRelay,
        private readonly webhookMetrics: WebhookMetrics,
    ) {}

    /**
     * A checkout for one product. The same Idempotency-Key with the same
     * request returns the same payment; with another request it is a 409.
     * While another request creates the provider checkout, the payment comes
     * back as 'creating': retry with the same key.
     */
    async checkout(
        userId: string,
        input: {
            productKey: string
            currency: Currency
        },
        idempotencyKey: string,
    ) {
        const product = productByKey(input.productKey)
        if (!product)
            throw new AppError('VALIDATION_FAILED', 'Request validation failed', [
                {
                    path: 'productKey',
                    message: 'unknown product',
                },
            ])
        const fingerprint = createHash('sha256').update(`${product.key}|${input.currency}`).digest('hex')
        let payment: PaymentRow
        try {
            const [created] = await this.db
                .insert(payments)
                .values({
                    userId,
                    productKey: product.key,
                    coins: product.coins,
                    amount: product.prices[input.currency],
                    currency: input.currency,
                    provider: this.provider.name,
                    idempotencyKey,
                    fingerprint,
                })
                .returning()
            if (!created) throw new Error('payment insert returned nothing')
            payment = created
        } catch (error) {
            if (!isUniqueViolation(error, 'payments_user_key_uq')) throw error
            const [existing] = await this.db
                .select()
                .from(payments)
                .where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, idempotencyKey)))
            if (!existing || existing.fingerprint !== fingerprint)
                throw new AppError('CONFLICT', 'The Idempotency-Key was used for another checkout')
            payment = existing
        }
        if (payment.status !== 'created' && payment.status !== 'creating') return this.view(payment)

        const user = await this.users.recipient(userId)
        if (!user || user.status !== 'active') throw new AppError('FORBIDDEN', 'Account not active')
        return this.view(
            await this.createCheckout(payment.id, {
                email: user.email,
                locale: user.locale,
            }),
        )
    }

    /**
     * One executor per payment creates the provider checkout: it claims the
     * payment in a short transaction, calls the provider outside any
     * transaction and writes the answer only while its claim holds. A claim
     * taken over from 'creating' first looks for the checkout of the earlier
     * attempt, whose outcome is unknown: a lost answer never makes a second one.
     */
    private async createCheckout(
        id: string,
        buyer: {
            email: string
            locale: 'en' | 'ru'
        },
    ) {
        const claim = await this.claimCheckout(id)
        if (!claim.token) return claim.payment
        let checkout: FoundCheckout
        try {
            const found = claim.uncertain ? await this.provider.findCheckout(claim.payment) : null
            checkout =
                found
                ?? (await this.provider.createCheckout({
                    payment: claim.payment,
                    ...buyer,
                }))
        } catch (error) {
            const refused = error instanceof CheckoutRefused
            await this.releaseCheckout(id, claim.token, refused)
            this.logger.warn(
                {
                    paymentId: id,
                    err: (error as Error).message,
                },
                refused
                    ? 'Provider refused the checkout'
                    : 'Checkout outcome unknown: the next attempt looks for it first',
            )
            throw new AppError('UNAVAILABLE', 'Payment provider unavailable, retry later')
        }
        return this.recordCheckout(id, claim.token, checkout)
    }

    /** The claim, or the payment as it stands: nothing to create, or another executor holds it. */
    private claimCheckout(id: string) {
        return this.db.transaction(async tx => {
            const [row] = await tx
                .select({
                    payment: payments,
                    leaseOver: sql<boolean>`coalesce(${payments.checkoutLeaseUntil} <= now(), true)`,
                })
                .from(payments)
                .where(eq(payments.id, id))
                .for('update')
            if (!row) throw notFound('Payment')
            const { payment, leaseOver } = row
            if (payment.status !== 'created' && !(payment.status === 'creating' && leaseOver))
                return {
                    payment,
                }
            const token = randomUUID()
            const [claimed] = await tx
                .update(payments)
                .set({
                    status: 'creating',
                    checkoutLeaseToken: token,
                    checkoutLeaseUntil: sql`now() + ${CHECKOUT_LEASE}`,
                    updatedAt: new Date(),
                })
                .where(eq(payments.id, id))
                .returning()
            if (!claimed) throw new Error('payment claim returned nothing')
            return {
                payment: claimed,
                token,
                uncertain: payment.status === 'creating',
            }
        })
    }

    /**
     * Gives the claim back. Refused: nothing was created, the next attempt
     * creates. Unknown: the payment stays 'creating' without a lease, and the
     * next attempt looks for the checkout first.
     */
    private async releaseCheckout(id: string, token: string, refused: boolean) {
        await this.db
            .update(payments)
            .set({
                status: refused ? 'created' : 'creating',
                checkoutLeaseToken: null,
                checkoutLeaseUntil: null,
                updatedAt: new Date(),
            })
            .where(and(eq(payments.id, id), eq(payments.status, 'creating'), eq(payments.checkoutLeaseToken, token)))
    }

    /**
     * The provider's answer, compare-and-set on the claim: written only while
     * this executor still holds it, so a late answer never moves a payment back
     * or replaces another checkout. Webhooks that came before the provider id
     * are applied in the same transaction.
     */
    private async recordCheckout(id: string, token: string, checkout: FoundCheckout) {
        const recorded = await this.db.transaction(async tx => {
            await this.lockProviderPayment(tx, checkout.providerPaymentId)
            const [ready] = await tx
                .update(payments)
                .set({
                    providerPaymentId: checkout.providerPaymentId,
                    checkoutUrl: checkout.checkoutUrl ?? null,
                    // Found again without its URL: nobody can pay it, the buyer starts over.
                    status: checkout.checkoutUrl ? 'pending' : 'failed',
                    failureReason: checkout.checkoutUrl ? null : 'checkout_lost',
                    checkoutLeaseToken: null,
                    checkoutLeaseUntil: null,
                    updatedAt: new Date(),
                })
                .where(
                    and(eq(payments.id, id), eq(payments.status, 'creating'), eq(payments.checkoutLeaseToken, token)),
                )
                .returning()
            if (!ready) return undefined
            return {
                payment: ready,
                outcomes: await this.applyReceived(tx, checkout.providerPaymentId),
            }
        })
        if (!recorded) {
            this.logger.warn(
                {
                    paymentId: id,
                    providerPaymentId: checkout.providerPaymentId,
                },
                'Provider answer came after the claim passed on: dropped',
            )
            return this.byId(id)
        }
        if (recorded.outcomes.length === 0) return recorded.payment
        for (const outcome of recorded.outcomes) this.webhookMetrics.count(resultOf(outcome))
        this.relay.kick()
        return this.byId(id)
    }

    /**
     * Serializes, per provider payment id, recording a webhook with writing
     * that id to its payment: whichever commits second sees the other, so a
     * webhook that arrives during the write is not left unmatched.
     */
    private async lockProviderPayment(tx: Tx, providerPaymentId: string) {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${this.provider.name}:${providerPaymentId}`}, 0))`,
        )
    }

    private async byId(id: string) {
        const [row] = await this.db.select().from(payments).where(eq(payments.id, id))
        if (!row) throw notFound('Payment')
        return row
    }

    async list(userId: string, limit: number, from?: string) {
        const after = from ? cursor.decode(from) : undefined
        const rows = await this.db
            .select()
            .from(payments)
            .where(
                and(
                    eq(payments.userId, userId),
                    after
                        ? or(
                              lt(payments.createdAt, new Date(after.createdAt)),
                              and(eq(payments.createdAt, new Date(after.createdAt)), lt(payments.id, after.id)),
                          )
                        : undefined,
                ),
            )
            .orderBy(desc(payments.createdAt), desc(payments.id))
            .limit(limit + 1)
        const page = rows.slice(0, limit)
        const last = page.at(-1)
        return {
            items: page.map(row => this.view(row)),
            nextCursor:
                rows.length > limit && last
                    ? cursor.encode({
                          createdAt: last.createdAt.toISOString(),
                          id: last.id,
                      })
                    : null,
        }
    }

    async get(userId: string, id: string) {
        const [row] = await this.db
            .select()
            .from(payments)
            .where(and(eq(payments.id, id), eq(payments.userId, userId)))
        if (!row) throw notFound('Payment')
        return this.view(row)
    }

    /**
     * An authenticated webhook: recorded once by its dedupe key with the fact
     * read from it, and applied in the same transaction. A success that leaves
     * out the amount or the currency is confirmed by the provider's own record
     * instead. One that finds no payment stays received (unmatched) and is
     * applied when its payment gets the provider id; a repeated delivery of it
     * tries again instead of counting as a duplicate.
     */
    async receive(parsed: ParsedWebhook, payloadSha256: string): Promise<WebhookResult> {
        const result = await this.settle(parsed, payloadSha256)
        this.webhookMetrics.count(result)
        if (result === 'applied') this.relay.kick()
        return result
    }

    private async settle(parsed: ParsedWebhook, payloadSha256: string): Promise<WebhookResult> {
        if ('rejected' in parsed) return this.reject(`rejected:${payloadSha256}`, payloadSha256, parsed.rejected)
        let fact = parsed.fact
        const incomplete = fact.amountMinor === undefined || fact.currency === undefined
        // Asked once: a delivery already recorded is settled by its stored fact.
        if (fact.outcome === 'succeeded' && incomplete && !(await this.recorded(fact.dedupeKey))) {
            const record = await this.lookup(fact.providerPaymentId)
            if (record === 'open')
                throw new AppError('UNAVAILABLE', 'The provider has not settled the payment yet, retry later')
            if (record?.outcome !== 'succeeded' || record.amountMinor === undefined || record.currency === undefined)
                return this.reject(
                    fact.dedupeKey,
                    payloadSha256,
                    'the provider does not confirm the success',
                    fact.providerPaymentId,
                )
            fact = {
                ...record,
                dedupeKey: fact.dedupeKey,
            }
        }
        const verified = fact
        return this.db.transaction(async tx => {
            await this.lockProviderPayment(tx, verified.providerPaymentId)
            const [inserted] = await tx
                .insert(webhookEvents)
                .values({
                    provider: this.provider.name,
                    dedupeKey: verified.dedupeKey,
                    payloadSha256,
                    outcome: 'unmatched',
                    providerPaymentId: verified.providerPaymentId,
                    paymentStatus: verified.outcome,
                    amountMinor: verified.amountMinor ?? null,
                    currency: verified.currency ?? null,
                })
                .onConflictDoNothing()
                .returning()
            const event = inserted ?? (await this.unapplied(tx, verified.dedupeKey))
            if (!event) return 'duplicate'
            return resultOf(await this.applyRecorded(tx, event))
        })
    }

    private async recorded(dedupeKey: string) {
        const [row] = await this.db
            .select({
                id: webhookEvents.id,
            })
            .from(webhookEvents)
            .where(and(eq(webhookEvents.provider, this.provider.name), eq(webhookEvents.dedupeKey, dedupeKey)))
        return Boolean(row)
    }

    /** The earlier delivery of this event, when it still waits for its payment. */
    private async unapplied(tx: Tx, dedupeKey: string) {
        const [earlier] = await tx
            .select()
            .from(webhookEvents)
            .where(and(eq(webhookEvents.provider, this.provider.name), eq(webhookEvents.dedupeKey, dedupeKey)))
            .for('update')
        return earlier?.outcome === 'unmatched' ? earlier : undefined
    }

    private async lookup(providerPaymentId: string) {
        try {
            return await this.provider.lookup(providerPaymentId)
        } catch (error) {
            this.logger.warn(
                {
                    err: (error as Error).message,
                },
                'Provider lookup failed',
            )
            throw new AppError('UNAVAILABLE', 'Payment provider unavailable, retry later')
        }
    }

    /** Recorded, never applied. */
    private async reject(
        dedupeKey: string,
        payloadSha256: string,
        reason: string,
        providerPaymentId?: string,
    ): Promise<WebhookResult> {
        const [recorded] = await this.db
            .insert(webhookEvents)
            .values({
                provider: this.provider.name,
                dedupeKey,
                payloadSha256,
                outcome: 'rejected',
                providerPaymentId,
            })
            .onConflictDoNothing()
            .returning({
                id: webhookEvents.id,
            })
        if (!recorded) return 'duplicate'
        this.logger.warn(
            {
                reason,
            },
            'Webhook rejected',
        )
        return 'rejected'
    }

    /** Webhooks received before their payment had the provider id, oldest first. */
    private async applyReceived(tx: Tx, providerPaymentId: string) {
        const received = await tx
            .select()
            .from(webhookEvents)
            .where(
                and(
                    eq(webhookEvents.provider, this.provider.name),
                    eq(webhookEvents.providerPaymentId, providerPaymentId),
                    eq(webhookEvents.outcome, 'unmatched'),
                ),
            )
            .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.id))
            .for('update')
        const outcomes: FactOutcome[] = []
        for (const event of received) outcomes.push(await this.applyRecorded(tx, event))
        return outcomes
    }

    /** A recorded webhook's fact → the payment; the event keeps what became of it. */
    private async applyRecorded(tx: Tx, event: WebhookEventRow) {
        const applied = await this.apply(tx, factOf(event))
        if (applied.outcome !== 'unmatched')
            await tx
                .update(webhookEvents)
                .set({
                    outcome: applied.outcome,
                    paymentId: applied.paymentId ?? null,
                    appliedAt: applied.outcome === 'mismatch' ? null : new Date(),
                })
                .where(eq(webhookEvents.id, event.id))
        return applied.outcome
    }

    /**
     * A trusted provider fact → the payment, under its row lock. Paid once:
     * a later failure never undoes a success; the amount in minor units and
     * the currency must be given and equal to the snapshot, otherwise nothing
     * changes (mismatch, logged).
     */
    async apply(
        tx: Tx,
        fact: ProviderFact,
    ): Promise<{
        outcome: FactOutcome
        paymentId?: string
    }> {
        const [payment] = await tx
            .select()
            .from(payments)
            .where(
                and(eq(payments.provider, this.provider.name), eq(payments.providerPaymentId, fact.providerPaymentId)),
            )
            .for('update')
        if (!payment)
            return {
                outcome: 'unmatched',
            }
        if (payment.status === 'succeeded')
            return {
                outcome: 'ignored',
                paymentId: payment.id,
            }
        if (fact.outcome === 'failed') {
            await tx
                .update(payments)
                .set({
                    status: 'failed',
                    failureReason: 'provider',
                    updatedAt: new Date(),
                })
                .where(eq(payments.id, payment.id))
            return {
                outcome: 'processed',
                paymentId: payment.id,
            }
        }
        if (fact.currency !== payment.currency || fact.amountMinor !== snapshotMinor(payment)) {
            this.logger.error(
                {
                    paymentId: payment.id,
                    amountMinor: fact.amountMinor?.toString(),
                    currency: fact.currency,
                },
                'Provider amount or currency differs from the order snapshot',
            )
            return {
                outcome: 'mismatch',
                paymentId: payment.id,
            }
        }
        const paidAt = new Date()
        await tx
            .update(payments)
            .set({
                status: 'succeeded',
                paidAt,
                updatedAt: paidAt,
            })
            .where(eq(payments.id, payment.id))
        await enqueueEvent(
            tx,
            paymentSucceeded.create({
                aggregateId: payment.id,
                payload: {
                    paymentId: payment.id,
                    userId: payment.userId,
                    productKey: payment.productKey,
                    coins: String(payment.coins),
                    amount: payment.amount,
                    currency: payment.currency,
                    provider: payment.provider,
                    paidAt: paidAt.toISOString(),
                },
            }),
        )
        return {
            outcome: 'processed',
            paymentId: payment.id,
        }
    }

    /** The fake provider's "pay" button: the same path as a webhook, for the payer only. */
    async completeFake(userId: string, id: string) {
        if (this.provider.name !== 'fake') throw notFound('Payment')
        const outcome = await this.db.transaction(async tx => {
            const [payment] = await tx
                .select()
                .from(payments)
                .where(and(eq(payments.id, id), eq(payments.userId, userId)))
            if (!payment?.providerPaymentId) throw notFound('Payment')
            return this.apply(tx, {
                providerPaymentId: payment.providerPaymentId,
                outcome: 'succeeded',
                amountMinor: snapshotMinor(payment),
                currency: payment.currency,
                dedupeKey: `fake:${payment.id}`,
            })
        })
        this.relay.kick()
        return {
            outcome: outcome.outcome,
            payment: await this.get(userId, id),
        }
    }

    view(row: PaymentRow) {
        return {
            id: row.id,
            productKey: row.productKey,
            coins: String(row.coins),
            amount: row.amount,
            currency: row.currency,
            provider: row.provider,
            status: row.status,
            checkoutUrl: row.status === 'pending' ? row.checkoutUrl : null,
            paidAt: row.paidAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        }
    }
}
