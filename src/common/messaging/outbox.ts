import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { currentContext } from '../context/request-context.js'
import type { AnyDb } from '../database/database.js'
import type { Envelope } from './event.js'
import { outbox } from './outbox.schema.js'
import { eventsExchange } from './topology.js'

/** The database or an open transaction. */
export type Executor = Pick<AnyDb, 'execute' | 'insert' | 'update' | 'delete'>

/**
 * Stores an event in the same transaction as the domain change: call it with
 * the transaction handle, never with a separate connection. Correlation ids
 * missing on the event come from the current request or consumed event.
 */
export async function enqueueEvent(tx: Executor, event: Envelope) {
    const context = currentContext()
    const envelope: Envelope = {
        ...event,
        correlationId: event.correlationId ?? context?.correlationId,
        causationId: event.causationId ?? context?.causationId,
    }
    await tx.insert(outbox).values({
        eventId: envelope.eventId,
        type: envelope.type,
        exchange: eventsExchange(envelope.producer),
        envelope,
    })
}

export type ClaimedEvent = {
    eventId: string
    exchange: string
    envelope: Envelope
    attempts: number
    leaseToken: string
}

/**
 * Claims up to `limit` due events under a fresh lease in one statement.
 * Concurrent relays (replicas) skip each other's rows; an expired lease
 * (crashed relay) becomes claimable again.
 */
export async function claimOutboxBatch(
    db: Executor,
    options: {
        limit: number
        leaseMs: number
    },
): Promise<ClaimedEvent[]> {
    const leaseToken = randomUUID()
    const result = await db.execute<{
        event_id: string
        exchange: string
        envelope: Envelope
        attempts: number
    }>(sql`
    update outbox
       set lease_token = ${leaseToken},
           lease_until = now() + make_interval(secs => ${options.leaseMs / 1000}),
           attempts = attempts + 1
     where event_id in (
       select event_id from outbox
        where status = 'pending'
          and available_at <= now()
          and (lease_until is null or lease_until < now())
        order by created_at
        limit ${options.limit}
        for update skip locked
     )
    returning event_id, exchange, envelope, attempts`)
    return result.rows.map(row => ({
        eventId: row.event_id,
        exchange: row.exchange,
        envelope: row.envelope,
        attempts: row.attempts,
        leaseToken,
    }))
}

/** Marks an event published, only while this relay still holds its lease. */
export async function markOutboxPublished(db: Executor, eventId: string, leaseToken: string) {
    const rows = await db
        .update(outbox)
        .set({
            status: 'published',
            publishedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
        })
        .where(and(eq(outbox.eventId, eventId), eq(outbox.leaseToken, leaseToken)))
        .returning({
            eventId: outbox.eventId,
        })
    return rows.length === 1
}

/** Returns a claimed event to the queue after a delay. */
export async function releaseOutboxEvent(
    db: Executor,
    eventId: string,
    leaseToken: string,
    options: {
        delayMs: number
        error: string
    },
) {
    await db
        .update(outbox)
        .set({
            leaseToken: null,
            leaseUntil: null,
            availableAt: new Date(Date.now() + options.delayMs),
            lastError: options.error.slice(0, 1000),
        })
        .where(and(eq(outbox.eventId, eventId), eq(outbox.leaseToken, leaseToken)))
}

/** Deletes published rows older than the retention window. */
export async function purgePublishedOutbox(db: Executor, olderThan: Date) {
    await db.delete(outbox).where(and(eq(outbox.status, 'published'), lt(outbox.publishedAt, olderThan)))
}

/** Unpublished events and the age of the oldest one in seconds (0 when none). */
export async function outboxBacklog(db: Executor) {
    const result = await db.execute<{
        pending: number
        oldest: number
    }>(sql`
    select count(*)::int as pending,
           coalesce(extract(epoch from now() - min(created_at)), 0)::float8 as oldest
      from outbox
     where status = 'pending'`)
    const [row] = result.rows
    return {
        pending: row?.pending ?? 0,
        oldestSeconds: row?.oldest ?? 0,
    }
}
