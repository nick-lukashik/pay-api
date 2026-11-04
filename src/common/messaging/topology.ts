/**
 * RabbitMQ topology conventions:
 * - one durable topic exchange per producer: `<producer>.events`, routing key = event type;
 * - every consumer owns its quorum queues: `<consumer>.<purpose>`;
 * - failures go to `<queue>.retry.<n>` (TTL, then dead-lettered back) and,
 *   after the last tier or for poison messages, to `<queue>.dlq`.
 */
export const eventsExchange = (producer: string) => `${producer}.events`
export const retryQueueName = (queue: string, tier: number) => `${queue}.retry.${tier}`
export const deadLetterQueueName = (queue: string) => `${queue}.dlq`

/** Header with the number of attempts already made. */
export const ATTEMPT_HEADER = 'x-attempt'

export const defaultRetryDelaysMs = [
    5_000,
    30_000,
    120_000,
] as const

export type QueueSpec = {
    name: string
    bindings: {
        exchange: string
        routingKey: string
    }[]
    retryDelaysMs: readonly number[]
    prefetch: number
}

export function defineQueue(
    name: string,
    bindings: {
        producer: string
        types: string[]
    }[],
    options: {
        retryDelaysMs?: readonly number[]
        prefetch?: number
    } = {},
): QueueSpec {
    return {
        name,
        bindings: bindings.flatMap(({ producer, types }) =>
            types.map(routingKey => ({
                exchange: eventsExchange(producer),
                routingKey,
            })),
        ),
        retryDelaysMs: options.retryDelaysMs ?? defaultRetryDelaysMs,
        prefetch: options.prefetch ?? 16,
    }
}

const quorum = {
    'x-queue-type': 'quorum',
} as const

/**
 * Broker-side dead-lettering that keeps a message in the source queue until
 * the target queue confirms it. Quorum queues only; RabbitMQ silently falls
 * back to at-most-once (drop on any failure) unless the overflow is
 * `reject-publish` and a dead-letter exchange is set.
 */
const atLeastOnce = (deadLetterRoutingKey: string) =>
    ({
        ...quorum,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': deadLetterRoutingKey,
    }) as const

export type QueueDeclaration = {
    name: string
    arguments: Record<string, string | number>
}

/**
 * Every queue a consumer declares, in order: the DLQ, the main queue
 * (messages over the quorum delivery limit go to the DLQ) and one retry queue
 * per delay (expired messages go back to the main queue). Arguments are part
 * of a queue's identity: changing them needs a new queue or a delete first.
 */
export function queueDeclarations(spec: QueueSpec): QueueDeclaration[] {
    const dlq = deadLetterQueueName(spec.name)
    return [
        {
            name: dlq,
            arguments: {
                ...quorum,
            },
        },
        {
            name: spec.name,
            arguments: atLeastOnce(dlq),
        },
        ...spec.retryDelaysMs.map((delay, tier) => ({
            name: retryQueueName(spec.name, tier),
            arguments: {
                ...atLeastOnce(spec.name),
                'x-message-ttl': delay,
            },
        })),
    ]
}
