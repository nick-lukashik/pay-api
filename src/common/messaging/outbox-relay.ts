import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap,
    Optional,
} from '@nestjs/common'
import { runDetached } from '../context/request-context.js'
import { type AnyDb, DB } from '../database/database.js'
import { Metrics } from '../metrics/metrics.js'
import { UnroutableError } from './confirm.js'
import {
    claimOutboxBatch,
    markOutboxPublished,
    outboxBacklog,
    purgePublishedOutbox,
    releaseOutboxEvent,
} from './outbox.js'
import { BrokerUnavailableError, RabbitMq } from './rabbitmq.js'

export type OutboxRelayOptions = {
    /** Poll interval when idle; `kick()` publishes right after a commit. */
    intervalMs?: number
    batchSize?: number
    leaseMs?: number
    /** How long published rows are kept. */
    retentionMs?: number
}

export const OUTBOX_RELAY_OPTIONS = Symbol('OUTBOX_RELAY_OPTIONS')

type FailureReason = 'unroutable' | 'unavailable' | 'error'

const failureReason = (error: unknown): FailureReason =>
    error instanceof UnroutableError ? 'unroutable' : error instanceof BrokerUnavailableError ? 'unavailable' : 'error'

/**
 * Publishes committed outbox events: claim a batch under a lease, publish
 * (mandatory, with broker confirm), mark published while still holding the
 * lease. A failure (unroutable, nack, no confirm, broker gone) keeps the row
 * pending and returns it with backoff; a crash between publish and mark
 * republishes the same eventId, which consumers deduplicate.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly logger = new Logger('OutboxRelay')
    private timer: NodeJS.Timeout | undefined
    private running: Promise<number> | undefined
    private stopped = false
    private lastPurge = 0
    private readonly intervalMs: number
    private readonly batchSize: number
    private readonly leaseMs: number
    private readonly retentionMs: number
    private readonly published
    private readonly failures

    constructor(
        @Inject(DB) private readonly db: AnyDb,
        private readonly rabbit: RabbitMq,
        @Inject(OUTBOX_RELAY_OPTIONS) options: OutboxRelayOptions,
        @Optional() metrics?: Metrics,
    ) {
        this.intervalMs = options.intervalMs ?? 1_000
        this.batchSize = options.batchSize ?? 50
        this.leaseMs = options.leaseMs ?? 30_000
        this.retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000
        const database = this.db
        // One query per scrape for both gauges.
        let last:
            | {
                  at: number
                  backlog: ReturnType<typeof outboxBacklog>
              }
            | undefined
        const backlog = () => {
            if (!last || Date.now() - last.at > 1_000) {
                last = {
                    at: Date.now(),
                    backlog: outboxBacklog(database),
                }
            }
            return last.backlog.catch(() => undefined)
        }
        metrics?.gauge({
            name: 'outbox_pending_events',
            help: 'Committed events not yet published to RabbitMQ; NaN when unknown.',
            async collect() {
                const value = await backlog()
                this.set(value ? value.pending : Number.NaN)
            },
        })
        metrics?.gauge({
            name: 'outbox_oldest_pending_seconds',
            help: 'Age of the oldest unpublished event (0 when none); NaN when unknown.',
            async collect() {
                const value = await backlog()
                this.set(value ? value.oldestSeconds : Number.NaN)
            },
        })
        this.published = metrics?.counter({
            name: 'outbox_published_total',
            help: 'Events published to RabbitMQ and confirmed by the broker.',
        })
        this.failures = metrics?.counter({
            name: 'outbox_publish_failures_total',
            help: 'Failed publish attempts by reason (unroutable, unavailable, error); the event stays pending.',
            labelNames: [
                'reason',
            ],
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

    /** Call after committing a transaction that enqueued events. */
    kick() {
        if (!this.running) this.schedule(0)
    }

    private schedule(delay: number) {
        if (this.stopped) return
        clearTimeout(this.timer)
        // Kicked from a request: later passes must not run inside its context.
        this.timer = runDetached(() =>
            setTimeout(() => {
                void this.tick()
            }, delay),
        )
    }

    /** One relay pass; returns how many events were published. */
    tick(): Promise<number> {
        this.running ??= this.pass().finally(() => {
            this.running = undefined
        })
        return this.running
    }

    private async pass(): Promise<number> {
        let published = 0
        let full = false
        try {
            if (!this.rabbit.connected) return 0
            const batch = await claimOutboxBatch(this.db, {
                limit: this.batchSize,
                leaseMs: this.leaseMs,
            })
            full = batch.length === this.batchSize
            for (const event of batch) {
                try {
                    await this.rabbit.publish(event.exchange, event.envelope)
                    this.published?.inc()
                    if (await markOutboxPublished(this.db, event.eventId, event.leaseToken)) published++
                } catch (error) {
                    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6))
                    const reason = failureReason(error)
                    this.failures?.inc({
                        reason,
                    })
                    this.logger.warn(
                        {
                            eventId: event.eventId,
                            type: event.envelope.type,
                            attempts: event.attempts,
                            reason,
                            err: (error as Error).message,
                        },
                        'Publish failed, will retry',
                    )
                    await releaseOutboxEvent(this.db, event.eventId, event.leaseToken, {
                        delayMs,
                        error: (error as Error).message,
                    }).catch(() => undefined)
                }
            }
            if (Date.now() - this.lastPurge > 3_600_000) {
                this.lastPurge = Date.now()
                await purgePublishedOutbox(this.db, new Date(Date.now() - this.retentionMs))
            }
        } catch (error) {
            this.logger.error(
                {
                    err: (error as Error).message,
                },
                'Outbox relay pass failed',
            )
        } finally {
            this.schedule(full ? 0 : this.intervalMs)
        }
        return published
    }
}
