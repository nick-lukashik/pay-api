import { randomUUID } from 'node:crypto'
import type { ConfirmChannel, Message, Options } from 'amqplib'

/** Unique per publish, so a returned message is matched to its own publish even when message ids repeat. */
export const PUBLISH_ID_HEADER = 'x-publish-id'

/** How long a publish waits for the broker's confirm (a blocked connection never confirms). */
export const CONFIRM_TIMEOUT_MS = 10_000

/** The broker returned a `mandatory` message: no queue is bound for it, so nothing was stored. */
export class UnroutableError extends Error {
    constructor(
        readonly exchange: string,
        readonly routingKey: string,
        reason: string,
    ) {
        super(`Unroutable: exchange "${exchange}", routing key "${routingKey}" (${reason})`)
        this.name = 'UnroutableError'
    }
}

export type ConfirmedPublish = (
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: Options.Publish,
) => Promise<void>

/**
 * Publishes on a confirm channel with `mandatory: true` and resolves only when
 * the broker has stored the message in at least one queue. RabbitMQ confirms
 * an unroutable message too, but sends `basic.return` before that confirm:
 * such a publish rejects with `UnroutableError`. A nack, a closed channel or
 * no confirm within `timeoutMs` rejects as well; the caller keeps the message.
 */
export function confirmedPublisher(channel: ConfirmChannel, timeoutMs = CONFIRM_TIMEOUT_MS): ConfirmedPublish {
    const pending = new Set<string>()
    const returned = new Map<string, string>()
    channel.on('return', (message: Message) => {
        const publishId = message.properties.headers?.[PUBLISH_ID_HEADER]
        const fields = message.fields as {
            replyCode?: number
            replyText?: string
        }
        if (typeof publishId === 'string' && pending.has(publishId)) {
            returned.set(publishId, `${fields.replyCode} ${fields.replyText}`)
        }
    })
    return async (exchange, routingKey, content, options = {}) => {
        const publishId = randomUUID()
        pending.add(publishId)
        let timer: NodeJS.Timeout | undefined
        const outcome = await new Promise<unknown>(resolve => {
            timer = setTimeout(() => resolve(new Error(`No publisher confirm within ${timeoutMs} ms`)), timeoutMs)
            try {
                channel.publish(
                    exchange,
                    routingKey,
                    content,
                    {
                        ...options,
                        mandatory: true,
                        headers: {
                            ...options.headers,
                            [PUBLISH_ID_HEADER]: publishId,
                        },
                    },
                    error => resolve(error ?? undefined),
                )
            } catch (error) {
                // A closed channel throws synchronously.
                resolve(error ?? new Error('Publish failed'))
            }
        })
        clearTimeout(timer)
        const reason = returned.get(publishId)
        pending.delete(publishId)
        returned.delete(publishId)
        if (reason !== undefined) throw new UnroutableError(exchange, routingKey, reason)
        if (outcome !== undefined) throw outcome
    }
}
