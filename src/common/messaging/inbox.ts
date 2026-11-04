import type { AnyDb, TxOf } from '../database/database.js'
import { inbox } from './outbox.schema.js'

/**
 * Applies a consumer's effect exactly once per (consumer, eventId): the inbox
 * row and the effect commit together, so a redelivered event is acknowledged
 * without repeating the effect. Only database work belongs in `effect`
 * (including pg-boss jobs sent with `fromDrizzle(tx, sql)`); emails or HTTP
 * calls go to a job instead.
 */
export async function processOnce<D extends AnyDb>(
    db: D,
    message: {
        consumer: string
        eventId: string
        type: string
    },
    effect: (tx: TxOf<D>) => Promise<void>,
): Promise<'processed' | 'duplicate'> {
    return db.transaction(async tx => {
        const inserted = await tx.insert(inbox).values(message).onConflictDoNothing().returning({
            eventId: inbox.eventId,
        })
        if (inserted.length === 0) return 'duplicate'
        await effect(tx as TxOf<D>)
        return 'processed'
    })
}
