import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const at = (name: string) =>
    timestamp(name, {
        withTimezone: true,
    })

/**
 * Transactional outbox: written in the same transaction as the domain change,
 * published afterwards by the relay. `envelope` holds the whole event.
 */
export const outbox = pgTable(
    'outbox',
    {
        eventId: uuid('event_id').primaryKey(),
        type: text('type').notNull(),
        exchange: text('exchange').notNull(),
        envelope: jsonb('envelope').notNull(),
        status: text('status', {
            enum: [
                'pending',
                'published',
            ],
        })
            .notNull()
            .default('pending'),
        attempts: integer('attempts').notNull().default(0),
        leaseToken: uuid('lease_token'),
        leaseUntil: at('lease_until'),
        availableAt: at('available_at').notNull().defaultNow(),
        lastError: text('last_error'),
        createdAt: at('created_at').notNull().defaultNow(),
        publishedAt: at('published_at'),
    },
    t => [
        index('outbox_pending_idx').on(t.availableAt, t.createdAt).where(sql`${t.status} = 'pending'`),
        index('outbox_published_idx').on(t.publishedAt).where(sql`${t.status} = 'published'`),
    ],
)

/** Inbox: one row per (consumer, event) turns a redelivery into a no-op. */
export const inbox = pgTable(
    'inbox',
    {
        consumer: text('consumer').notNull(),
        eventId: uuid('event_id').notNull(),
        type: text('type').notNull(),
        processedAt: at('processed_at').notNull().defaultNow(),
    },
    t => [
        primaryKey({
            columns: [
                t.consumer,
                t.eventId,
            ],
        }),
    ],
)
