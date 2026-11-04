import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    Logger,
    type OnApplicationShutdown,
    type OnModuleInit,
    Optional,
} from '@nestjs/common'
import {
    type ChannelModel,
    type ConfirmChannel,
    type ConsumeMessage,
    connect,
    type Options,
    type RecoveringChannelModel,
} from 'amqplib'
import { runWithContext } from '../context/request-context.js'
import { DependencyDownError, HealthRegistry } from '../health/health.registry.js'
import { Metrics } from '../metrics/metrics.js'
import { type ConfirmedPublish, confirmedPublisher } from './confirm.js'
import { type Envelope, envelopeSchema } from './event.js'
import { ATTEMPT_HEADER, deadLetterQueueName, type QueueSpec, queueDeclarations, retryQueueName } from './topology.js'

export type RabbitMqOptions = {
    url: string
    /** Shown in the management UI. */
    connectionName: string
    /** Exchanges this service publishes to; declared on every (re)connect. */
    exchanges: string[]
    /**
     * How long startup waits for the first connection. RabbitMQ is degradable:
     * after that the service starts without it and keeps reconnecting.
     */
    startupWaitMs?: number
}

export const RABBITMQ_OPTIONS = Symbol('RABBITMQ_OPTIONS')

/** Throw from a handler when retrying cannot help (bad data): straight to the DLQ. */
export class PermanentError extends Error {}

/** No connection to the broker right now; the outbox keeps the event. */
export class BrokerUnavailableError extends Error {
    override name = 'BrokerUnavailableError'
}

export type EventHandler = (
    event: Envelope,
    context: {
        attempt: number
        redelivered: boolean
    },
) => Promise<void>

/** A consumer's channel; `open` turns false on its `close` event. */
type ConsumerChannel = {
    channel: ConfirmChannel
    publish: ConfirmedPublish
    open: boolean
    tag?: string
}

type Subscription = {
    spec: QueueSpec
    handler: EventHandler
    /** Subscribed and receiving messages. */
    up: boolean
    starting: boolean
    current?: ConsumerChannel
    restartTimer?: NodeJS.Timeout
    /** Restarts in a row, for the backoff. */
    failures: number
    lastRestart?: RestartReason
}

type RestartReason = 'cancelled' | 'channel_closed' | 'start_failed' | 'move_failed'

type Publisher = {
    channel: ConfirmChannel
    publish: ConfirmedPublish
}

/** Longest wait for in-flight handlers on shutdown (part of the 25 s budget in main.ts). */
const DRAIN_TIMEOUT_MS = 10_000
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 30_000

/**
 * RabbitMQ over one recovering amqplib connection. Exchanges and the
 * publisher channel are (re)created in `setup` after each connect. Every
 * consumer has its own channel and is supervised on its own: a broker cancel
 * (queue deleted) or a closed channel re-subscribes it with backoff, without
 * waiting for a reconnect. Publishing is mandatory and resolves only after the
 * broker stored the message; a message is acked only after its handler
 * finished or it was safely moved to a retry queue or the DLQ.
 */
@Injectable()
export class RabbitMq implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown {
    private readonly logger = new Logger('RabbitMq')
    private connection: RecoveringChannelModel | undefined
    private model: ChannelModel | undefined
    private publisher: Publisher | undefined
    private openingPublisher: Promise<Publisher> | undefined
    private readonly subscriptions: Subscription[] = []
    private readonly inFlight = new Set<Promise<void>>()
    private stopping = false
    private readonly consumed
    private readonly restarts
    private readonly moveFailures

    constructor(
        @Inject(RABBITMQ_OPTIONS) private readonly options: RabbitMqOptions,
        private readonly health: HealthRegistry,
        @Optional() metrics?: Metrics,
    ) {
        const connected = () => this.connected
        const consumers = () => this.consumerStates()
        this.consumed = metrics?.counter({
            name: 'messaging_events_consumed_total',
            help: 'Consumed events by queue and outcome (processed, retried, dead_lettered).',
            labelNames: [
                'queue',
                'outcome',
            ],
        })
        this.restarts = metrics?.counter({
            name: 'messaging_consumer_restarts_total',
            help: 'Consumer re-subscriptions by queue and reason (cancelled, channel_closed, start_failed, move_failed).',
            labelNames: [
                'queue',
                'reason',
            ],
        })
        this.moveFailures = metrics?.counter({
            name: 'messaging_move_failures_total',
            help: 'Failed moves to a retry queue or the DLQ; the message stays in its queue.',
            labelNames: [
                'queue',
            ],
        })
        metrics?.gauge({
            name: 'messaging_broker_up',
            help: '1 while connected to RabbitMQ, 0 while events wait in the outbox.',
            collect() {
                this.set(connected() ? 1 : 0)
            },
        })
        metrics?.gauge({
            name: 'messaging_consumer_up',
            help: '1 while the consumer of a queue is subscribed, 0 while it is being re-established.',
            labelNames: [
                'queue',
            ],
            collect() {
                for (const [queue, state] of Object.entries(consumers())) {
                    this.set(
                        {
                            queue,
                        },
                        state === 'up' ? 1 : 0,
                    )
                }
            },
        })
    }

    get connected() {
        return this.model !== undefined
    }

    /** Every subscribed queue and whether its consumer is up (health, metrics, tests). */
    consumerStates(): Record<string, 'up' | 'down'> {
        return Object.fromEntries(
            this.subscriptions.map(sub => [
                sub.spec.name,
                sub.up ? 'up' : 'down',
            ]),
        )
    }

    /** The channel consuming `queue`, for diagnostics and tests. */
    consumerChannel(queue: string): ConfirmChannel | undefined {
        return this.subscriptions.find(sub => sub.spec.name === queue)?.current?.channel
    }

    async onModuleInit() {
        this.health.register(
            'rabbitmq',
            async () => {
                const consumers = this.consumerStates()
                if (!this.connected)
                    throw new DependencyDownError('not connected', {
                        consumers,
                    })
                const down = Object.keys(consumers).filter(queue => consumers[queue] === 'down')
                if (down.length > 0)
                    throw new DependencyDownError(`consumers down: ${down.join(', ')}`, {
                        consumers,
                    })
                return {
                    consumers,
                }
            },
            {
                required: false,
            },
        )
        const connection = await connect(this.options.url, {
            clientProperties: {
                connection_name: this.options.connectionName,
            },
            recovery: {
                waitForConnect: false,
                maxRetries: Number.POSITIVE_INFINITY,
                maxDelay: 10_000,
                setup: (model: ChannelModel) => this.setup(model),
            },
        })
        this.connection = connection
        connection.on('disconnect', (err: Error) => {
            this.model = undefined
            this.publisher = undefined
            for (const sub of this.subscriptions) {
                clearTimeout(sub.restartTimer)
                sub.restartTimer = undefined
                sub.current = undefined
                sub.up = false
            }
            if (!this.stopping)
                this.logger.warn(
                    {
                        err: err.message,
                    },
                    'RabbitMQ disconnected; events wait in the outbox',
                )
        })
        connection.on('connect', () => this.logger.log('RabbitMQ connected'))
        connection.on('connect-failed', (err: Error) =>
            this.logger.warn(
                {
                    err: err.message,
                },
                'RabbitMQ connection attempt failed',
            ),
        )
        connection.on('reconnect-failed', (err: Error) =>
            this.logger.error(
                {
                    err: err.message,
                },
                'RabbitMQ recovery gave up',
            ),
        )
        connection.on('error', (err: Error) =>
            this.logger.warn(
                {
                    err: err.message,
                },
                'RabbitMQ connection error',
            ),
        )
        connection.on('handler-error', (err: Error) =>
            this.logger.error(
                {
                    err,
                },
                'RabbitMQ event handler threw',
            ),
        )
        connection.on('blocked', (reason: string) =>
            this.logger.warn(
                {
                    reason,
                },
                'RabbitMQ blocked publishing',
            ),
        )
        connection.on('unblocked', () => this.logger.log('RabbitMQ unblocked publishing'))

        const waitMs = this.options.startupWaitMs ?? 5_000
        let timer: NodeJS.Timeout | undefined
        const ready = await Promise.race([
            connection.waitForConnect().then(
                () => true,
                () => false,
            ),
            new Promise<false>(resolve => {
                timer = setTimeout(() => resolve(false), waitMs)
            }),
        ])
        clearTimeout(timer)
        if (!ready)
            this.logger.warn(
                {
                    waitedMs: waitMs,
                },
                'RabbitMQ unavailable at startup; starting without it, events wait in the outbox',
            )
    }

    /** Stop taking new messages and wait for the ones being handled. */
    async beforeApplicationShutdown() {
        this.stopping = true
        for (const sub of this.subscriptions) clearTimeout(sub.restartTimer)
        await Promise.allSettled(
            this.subscriptions.map(({ current }) =>
                current?.open && current.tag ? current.channel.cancel(current.tag) : undefined,
            ),
        )
        const pending = this.inFlight.size
        // Bounded so a stuck handler cannot hold the pod past its grace period;
        // an unfinished message is not acked and RabbitMQ redelivers it.
        const drained = await Promise.race([
            Promise.allSettled([
                ...this.inFlight,
            ]).then(() => true),
            new Promise<false>(resolve => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS).unref()),
        ])
        this.logger.log(
            {
                drained: pending,
                timedOut: !drained,
            },
            'Consumers stopped',
        )
    }

    async onApplicationShutdown() {
        this.stopping = true
        await this.connection?.close().catch(() => undefined)
    }

    /** Runs after every successful (re)connect, before the connection is used. */
    private async setup(model: ChannelModel) {
        const publisher = await this.openPublisher(model)
        this.model = model
        this.publisher = publisher
        for (const sub of this.subscriptions) {
            clearTimeout(sub.restartTimer)
            sub.restartTimer = undefined
            sub.current = undefined
            sub.up = false
            sub.failures = 0
            // Not awaited: a consumer that cannot start retries on its own and
            // must not fail the connection (and with it publishing).
            void this.startConsumer(sub)
        }
    }

    private async openPublisher(model: ChannelModel): Promise<Publisher> {
        const channel = await model.createConfirmChannel()
        this.watch(channel, 'publisher')
        const publisher = {
            channel,
            publish: confirmedPublisher(channel),
        }
        // E.g. a publish to a deleted exchange closes the channel: the next publish opens a new one.
        channel.on('close', () => {
            if (this.publisher === publisher) this.publisher = undefined
        })
        for (const exchange of new Set(this.options.exchanges)) {
            await channel.assertExchange(exchange, 'topic', {
                durable: true,
            })
        }
        return publisher
    }

    private async publisherChannel(): Promise<Publisher> {
        if (this.publisher) return this.publisher
        const model = this.model
        if (!model) throw new BrokerUnavailableError('RabbitMQ is not connected')
        this.openingPublisher ??= this.openPublisher(model)
            .then(publisher => {
                if (this.model === model) this.publisher = publisher
                return publisher
            })
            .finally(() => {
                this.openingPublisher = undefined
            })
        return this.openingPublisher
    }

    private watch(channel: ConfirmChannel, name: string) {
        channel.on('error', (err: Error) =>
            this.logger.warn(
                {
                    err: err.message,
                    channel: name,
                },
                'Channel error',
            ),
        )
        channel.on('handler-error', (err: Error) =>
            this.logger.error(
                {
                    err,
                    channel: name,
                },
                'Channel handler threw',
            ),
        )
    }

    /**
     * Publishes an envelope with the event type as routing key. Resolves once
     * the broker stored it in a queue; rejects when it is unroutable
     * (`UnroutableError`), nacked, not confirmed in time or the broker is down.
     */
    async publish(exchange: string, event: Envelope) {
        const { publish } = await this.publisherChannel()
        const options: Options.Publish = {
            persistent: true,
            contentType: 'application/json',
            messageId: event.eventId,
            type: event.type,
            timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
            ...(event.correlationId
                ? {
                      correlationId: event.correlationId,
                  }
                : {}),
        }
        await publish(exchange, event.type, Buffer.from(JSON.stringify(event)), options)
    }

    /**
     * Declares the queue with its retry tiers and DLQ and consumes it, now and
     * after every reconnect, cancel or channel loss. Call from `onApplicationBootstrap`.
     */
    async subscribe(spec: QueueSpec, handler: EventHandler) {
        const subscription: Subscription = {
            spec,
            handler,
            up: false,
            starting: false,
            failures: 0,
        }
        this.subscriptions.push(subscription)
        await this.startConsumer(subscription)
    }

    private async startConsumer(sub: Subscription) {
        const model = this.model
        if (!model || this.stopping || sub.up || sub.starting) return
        sub.starting = true
        const { spec } = sub
        try {
            let current = sub.current
            if (!current?.open) {
                current = await this.openConsumerChannel(model, sub)
                sub.current = current
            }
            const { channel } = current
            for (const queue of queueDeclarations(spec)) {
                await channel.assertQueue(queue.name, {
                    durable: true,
                    arguments: queue.arguments,
                })
            }
            for (const { exchange, routingKey } of spec.bindings) {
                await channel.assertExchange(exchange, 'topic', {
                    durable: true,
                })
                await channel.bindQueue(spec.name, exchange, routingKey)
            }
            await channel.prefetch(spec.prefetch)
            const consumer = current
            const { consumerTag } = await channel.consume(
                spec.name,
                message => {
                    if (!message) {
                        this.onCancelled(sub, consumer)
                        return
                    }
                    const work = this.handle(sub, consumer, message).finally(() => this.inFlight.delete(work))
                    this.inFlight.add(work)
                },
                {
                    noAck: false,
                },
            )
            if (!consumer.open || sub.current !== consumer) throw new Error('channel closed while subscribing')
            consumer.tag = consumerTag
            sub.up = true
            // A move that keeps failing keeps its backoff until a move succeeds.
            if (sub.lastRestart !== 'move_failed') sub.failures = 0
            this.logger.log(
                {
                    queue: spec.name,
                },
                'Consumer subscribed',
            )
        } catch (error) {
            this.logger.warn(
                {
                    queue: spec.name,
                    err: (error as Error).message,
                },
                'Consumer could not subscribe, will retry',
            )
            this.scheduleRestart(sub, 'start_failed')
        } finally {
            sub.starting = false
        }
    }

    private async openConsumerChannel(model: ChannelModel, sub: Subscription): Promise<ConsumerChannel> {
        const channel = await model.createConfirmChannel()
        this.watch(channel, sub.spec.name)
        const consumer: ConsumerChannel = {
            channel,
            publish: confirmedPublisher(channel),
            open: true,
        }
        channel.on('close', () => {
            consumer.open = false
            this.onChannelClosed(sub, consumer)
        })
        return consumer
    }

    /** The broker cancelled the consumer (e.g. the queue was deleted); the channel is still open. */
    private onCancelled(sub: Subscription, consumer: ConsumerChannel) {
        if (sub.current !== consumer) return
        consumer.tag = undefined
        sub.up = false
        this.logger.warn(
            {
                queue: sub.spec.name,
            },
            'Consumer cancelled by the broker, re-subscribing',
        )
        this.scheduleRestart(sub, 'cancelled')
    }

    private onChannelClosed(sub: Subscription, consumer: ConsumerChannel) {
        if (sub.current !== consumer) return
        sub.current = undefined
        sub.up = false
        if (this.stopping) return
        this.logger.warn(
            {
                queue: sub.spec.name,
            },
            'Consumer channel closed, re-subscribing',
        )
        this.scheduleRestart(sub, 'channel_closed')
    }

    /** Closes the consumer's channel (unacked messages return to the queue) and subscribes again. */
    private restartConsumer(sub: Subscription, consumer: ConsumerChannel, reason: RestartReason) {
        if (sub.current !== consumer) return
        sub.current = undefined
        sub.up = false
        consumer.channel.close().catch(() => undefined)
        this.scheduleRestart(sub, reason)
    }

    private scheduleRestart(sub: Subscription, reason: RestartReason) {
        if (this.stopping || sub.restartTimer) return
        const base = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(sub.failures, 10))
        const delay = Math.round(base * (0.8 + Math.random() * 0.4))
        sub.failures++
        sub.lastRestart = reason
        sub.restartTimer = setTimeout(() => {
            sub.restartTimer = undefined
            // Without a connection `setup` re-subscribes everything after the reconnect.
            if (!this.model || this.stopping) return
            this.restarts?.inc({
                queue: sub.spec.name,
                reason,
            })
            void this.startConsumer(sub)
        }, delay)
        sub.restartTimer.unref()
    }

    private async handle(sub: Subscription, consumer: ConsumerChannel, message: ConsumeMessage) {
        const { spec } = sub
        const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 0)
        const parsed = envelopeSchema.safeParse(safeJson(message.content.toString('utf8')))
        if (!parsed.success) {
            this.logger.error(
                {
                    queue: spec.name,
                    messageId: message.properties.messageId,
                },
                'Invalid message, moving to DLQ',
            )
            if (await this.moveTo(sub, consumer, message, deadLetterQueueName(spec.name), attempt, 'invalid')) {
                this.consumed?.inc({
                    queue: spec.name,
                    outcome: 'dead_lettered',
                })
            }
            return
        }
        const event = parsed.data
        // The handler and every log line about it run in the event's correlation.
        const context = {
            correlationId: event.correlationId ?? event.eventId,
            causationId: event.eventId,
        }
        return runWithContext(context, () => this.dispatch(sub, consumer, message, event, attempt))
    }

    private async dispatch(
        sub: Subscription,
        consumer: ConsumerChannel,
        message: ConsumeMessage,
        event: Envelope,
        attempt: number,
    ) {
        const { spec, handler } = sub
        const log = {
            queue: spec.name,
            eventId: event.eventId,
            type: event.type,
            attempt,
        }
        let failure: unknown
        try {
            await handler(event, {
                attempt,
                redelivered: message.fields.redelivered,
            })
        } catch (error) {
            failure = error
        }
        if (failure === undefined) {
            this.ack(consumer, message)
            this.consumed?.inc({
                queue: spec.name,
                outcome: 'processed',
            })
            this.logger.log(log, 'Event handled')
            return
        }
        const dead = failure instanceof PermanentError || attempt >= spec.retryDelaysMs.length
        const target = dead ? deadLetterQueueName(spec.name) : retryQueueName(spec.name, attempt)
        const reason = failure instanceof Error ? failure.message : String(failure)
        this.logger.warn(
            {
                ...log,
                target,
                err: reason,
            },
            'Event handling failed',
        )
        if (await this.moveTo(sub, consumer, message, target, attempt + 1, reason)) {
            this.consumed?.inc({
                queue: spec.name,
                outcome: dead ? 'dead_lettered' : 'retried',
            })
        }
    }

    /** Acks on the channel the message came from; a closed channel means the broker redelivers it. */
    private ack(consumer: ConsumerChannel, message: ConsumeMessage) {
        try {
            consumer.channel.ack(message)
        } catch {
            this.logger.warn(
                {
                    messageId: message.properties.messageId,
                },
                'Channel closed before ack; the message will be redelivered',
            )
        }
    }

    /**
     * Copies the message to `queue` (mandatory, confirmed), then acks the
     * original. If the copy fails (target queue missing, nack, broker gone),
     * the original is not acked: the consumer restarts, which returns it to its
     * queue and declares the retry queues and the DLQ again.
     */
    private async moveTo(
        sub: Subscription,
        consumer: ConsumerChannel,
        message: ConsumeMessage,
        queue: string,
        attempt: number,
        reason: string,
    ): Promise<boolean> {
        try {
            await consumer.publish('', queue, message.content, {
                ...message.properties,
                persistent: true,
                headers: {
                    ...message.properties.headers,
                    [ATTEMPT_HEADER]: attempt,
                    'x-last-error': reason.slice(0, 500),
                },
            })
        } catch (error) {
            this.logger.error(
                {
                    queue: sub.spec.name,
                    target: queue,
                    err: (error as Error).message,
                },
                'Could not move message; it stays in its queue',
            )
            this.moveFailures?.inc({
                queue: sub.spec.name,
            })
            this.restartConsumer(sub, consumer, 'move_failed')
            return false
        }
        this.ack(consumer, message)
        sub.lastRestart = undefined
        return true
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}
