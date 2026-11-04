import { type Channel, connect } from 'amqplib'
import { confirmedPublisher } from './confirm.js'
import { ATTEMPT_HEADER, deadLetterQueueName } from './topology.js'

export type ReplayResult = {
    queue: string
    replayed: number
    /** Messages left in the DLQ afterwards. */
    remaining: number
}

/** The DLQ or the queue it replays into does not exist: nothing was moved. */
export class QueueMissingError extends Error {
    override name = 'QueueMissingError'
}

async function messageCount(channel: Channel, queue: string) {
    try {
        return (await channel.checkQueue(queue)).messageCount
    } catch {
        throw new QueueMissingError(`Queue "${queue}" does not exist`)
    }
}

/**
 * Moves messages from `<queue>.dlq` back to `<queue>`, oldest first, after the
 * cause was fixed. Each message is published with `mandatory` and a broker
 * confirm before the DLQ copy is acked, so a failure (target missing, nack)
 * leaves it in the DLQ; a crash in between gives a duplicate, which the inbox
 * absorbs. The attempt counter restarts, so the full retry chain applies again.
 * At most the messages present at the start are taken: one that fails again
 * goes to the back and is not replayed twice in one run.
 */
export async function replayDeadLetters(
    url: string,
    queue: string,
    options: {
        limit?: number
        connectionName?: string
    } = {},
): Promise<ReplayResult> {
    const dlq = deadLetterQueueName(queue)
    const connection = await connect(url, {
        clientProperties: {
            connection_name: options.connectionName ?? 'replay-dlq',
        },
    })
    try {
        // A failed check closes the channel: one channel per check.
        const inspect = await connection.createChannel()
        inspect.on('error', () => undefined)
        const available = await messageCount(inspect, dlq)
        const target = await connection.createChannel()
        target.on('error', () => undefined)
        await messageCount(target, queue)

        const channel = await connection.createConfirmChannel()
        channel.on('error', () => undefined)
        const publish = confirmedPublisher(channel)
        const limit = Math.min(options.limit ?? Number.POSITIVE_INFINITY, available)
        let replayed = 0
        while (replayed < limit) {
            const message = await channel.get(dlq, {
                noAck: false,
            })
            if (!message) break
            try {
                await publish('', queue, message.content, {
                    ...message.properties,
                    persistent: true,
                    headers: {
                        ...message.properties.headers,
                        [ATTEMPT_HEADER]: 0,
                        'x-replayed-from': dlq,
                    },
                })
            } catch (error) {
                // Back to the DLQ (closing the connection would return it as well).
                try {
                    channel.nack(message, false, true)
                } catch {}
                throw error
            }
            channel.ack(message)
            replayed++
        }
        return {
            queue,
            replayed,
            remaining: await messageCount(inspect, dlq),
        }
    } finally {
        await connection.close().catch(() => undefined)
    }
}
