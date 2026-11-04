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
        /**
         * created: no provider checkout yet; creating: one executor creates it
         * (under the lease below), or an attempt's outcome is unknown (no lease):
         * the next one looks for it at the provider first.
         */
        status: text('status', {
            enum: [
                'created',
                'creating',
                'pending',
                'succeeded',
                'failed',
            ],
        })
            .notNull()
            .default('created'),
        idempotencyKey: text('idempotency_key').notNull(),
        fingerprint: text('fingerprint').notNull(),
        /** provider (a failure webhook) or checkout_lost (found again without its URL). */
        failureReason: text('failure_reason'),
        /** The executor creating the provider checkout; its answer is written only while this holds. */
        checkoutLeaseToken: uuid('checkout_lease_token'),
        checkoutLeaseUntil: at('checkout_lease_until'),
        paidAt: at('paid_at'),
        /** When reconciliation saw the pack in wallet-api's ledger; a succeeded payment without it is still checked. */
        reconciledAt: at('reconciled_at'),
        createdAt: at('created_at').notNull().defaultNow(),
        updatedAt: at('updated_at').notNull().defaultNow(),
    },
    t => [
        uniqueIndex('payments_user_key_uq').on(t.userId, t.idempotencyKey),
        uniqueIndex('payments_provider_id_uq').on(t.provider, t.providerPaymentId),
        index('payments_user_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
        index('payments_unreconciled_idx').on(t.id).where(sql`${t.status} = 'succeeded' and ${t.reconciledAt} is null`),
        check('payments_coins_positive', sql`${t.coins} > 0`),
    ],
)

/**
 * Every webhook that passed authentication, once per dedupe key (the event's
 * identity). The payload itself is not kept, only its hash and the fact read
 * from it, so a webhook that came before its payment had the provider id is
 * applied once it has: received_at and applied_at are separate.
 */
export const webhookEvents = pgTable(
    'webhook_events',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        provider: text('provider').notNull(),
        dedupeKey: text('dedupe_key').notNull(),
        payloadSha256: text('payload_sha256').notNull(),
        /** unmatched: received, waiting for its payment; mismatch and rejected are never applied. */
        outcome: text('outcome', {
            enum: [
                'processed',
                'ignored',
                'unmatched',
                'mismatch',
                'rejected',
            ],
        }).notNull(),
        paymentId: uuid('payment_id'),
        /** The fact, verified and normalized: what is applied later. */
        providerPaymentId: text('provider_payment_id'),
        paymentStatus: text('payment_status', {
            enum: [
                'succeeded',
                'failed',
            ],
        }),
        /** Minor units (kopecks, cents). */
        amountMinor: bigint('amount_minor', {
            mode: 'bigint',
        }),
        currency: text('currency', {
            enum: [
                'RUB',
                'USD',
                'EUR',
            ],
        }),
        receivedAt: at('received_at').notNull().defaultNow(),
        appliedAt: at('applied_at'),
    },
    t => [
        uniqueIndex('webhook_events_dedupe_uq').on(t.provider, t.dedupeKey),
        index('webhook_events_unmatched_idx')
            .on(t.provider, t.providerPaymentId)
            .where(sql`${t.outcome} = 'unmatched'`),
    ],
)
