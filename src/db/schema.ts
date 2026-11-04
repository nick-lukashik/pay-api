import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

// Platform tables every service with events carries: outbox and inbox.
export { inbox, outbox } from '../common/messaging/outbox.schema.js'

/** Millisecond precision, so an ISO string from JSON round-trips exactly (cursors). */
const at = (name: string) =>
    timestamp(name, {
        withTimezone: true,
        precision: 3,
    })

/**
 * One checkout. The server decides the user, the product, the coins, the amount
 * and the currency from the catalog: the snapshot is immutable, and a provider
 * fact is applied only when it matches it. A return URL proves nothing.
 */
export const payments = pgTable(
    'payments',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        userId: uuid('user_id').notNull(),
        productKey: text('product_key').notNull(),
        coins: bigint('coins', {
            mode: 'number',
        }).notNull(),
        /** Decimal string, as in the catalog ("449", "4.99"). */
        amount: text('amount').notNull(),
        currency: text('currency', {
            enum: [
                'RUB',
                'USD',
                'EUR',
            ],
        }).notNull(),
        provider: text('provider').notNull(),
        providerPaymentId: text('provider_payment_id'),
        checkoutUrl: text('checkout_url'),
        status: text('status', {
            enum: [
                'created',
                'pending',
                'succeeded',
                'failed',
            ],
        })
            .notNull()
            .default('created'),
        idempotencyKey: text('idempotency_key').notNull(),
        fingerprint: text('fingerprint').notNull(),
        failureReason: text('failure_reason'),
        paidAt: at('paid_at'),
        createdAt: at('created_at').notNull().defaultNow(),
        updatedAt: at('updated_at').notNull().defaultNow(),
    },
    t => [
        uniqueIndex('payments_user_key_uq').on(t.userId, t.idempotencyKey),
        uniqueIndex('payments_provider_id_uq').on(t.provider, t.providerPaymentId),
        index('payments_user_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
        check('payments_coins_positive', sql`${t.coins} > 0`),
    ],
)

/**
 * Every webhook that passed authentication, once per dedupe key; the payload
 * itself is not kept, only its hash and the outcome.
 */
export const webhookEvents = pgTable(
    'webhook_events',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        provider: text('provider').notNull(),
        dedupeKey: text('dedupe_key').notNull(),
        payloadSha256: text('payload_sha256').notNull(),
        outcome: text('outcome', {
            enum: [
                'processed',
                'ignored',
                'unmatched',
                'mismatch',
                'invalid',
            ],
        }).notNull(),
        paymentId: uuid('payment_id'),
        receivedAt: at('received_at').notNull().defaultNow(),
    },
    t => [
        uniqueIndex('webhook_events_dedupe_uq').on(t.provider, t.dedupeKey),
    ],
)
