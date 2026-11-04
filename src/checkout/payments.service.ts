import { createHash } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { type Currency, paymentSucceededV1 } from '@nick-lukashik/contracts'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { productByKey } from '../catalog/catalog.js'
import { DB, isUniqueViolation } from '../common/database/database.js'
import { AppError, notFound } from '../common/http/app-error.js'
import { cursorCodec } from '../common/http/cursor.js'
import { defineEvent } from '../common/messaging/event.js'
import { enqueueEvent } from '../common/messaging/outbox.js'
import { OutboxRelay } from '../common/messaging/outbox-relay.js'
import { payments } from '../db/schema.js'
import type { Db, PaymentRow, Tx } from '../db/types.js'
import { PaymentProvider, type ProviderFact } from '../providers/provider.js'
import { IdClient } from './id-client.js'

export const paymentSucceeded = defineEvent(
    paymentSucceededV1.type,
    paymentSucceededV1.producer,
    paymentSucceededV1.payload,
)

const cursor = cursorCodec(
    z.object({
        createdAt: z.iso.datetime(),
        id: z.uuid(),
    }),
)
const sameMoney = (a: string, b: string) => Number(a).toFixed(2) === Number(b).toFixed(2)

export type FactOutcome = 'processed' | 'ignored' | 'unmatched' | 'mismatch'

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger('Payments')

    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly provider: PaymentProvider,
        private readonly users: IdClient,
        private readonly relay: OutboxRelay,
    ) {}

    /**
     * A checkout for one product. The same Idempotency-Key with the same
     * request returns the same payment; with another request it is a 409.
     */
    async checkout(
        userId: string,
        input: {
            productKey: string
            currency: Currency
        },
        idempotencyKey: string,
    ) {
        const product = productByKey(input.productKey)
        if (!product)
            throw new AppError('VALIDATION_FAILED', 'Request validation failed', [
                {
                    path: 'productKey',
                    message: 'unknown product',
                },
            ])
        const fingerprint = createHash('sha256').update(`${product.key}|${input.currency}`).digest('hex')
        let payment: PaymentRow
        try {
            const [created] = await this.db
                .insert(payments)
                .values({
                    userId,
                    productKey: product.key,
                    coins: product.coins,
                    amount: product.prices[input.currency],
                    currency: input.currency,
                    provider: this.provider.name,
                    idempotencyKey,
                    fingerprint,
                })
                .returning()
            if (!created) throw new Error('payment insert returned nothing')
            payment = created
        } catch (error) {
            if (!isUniqueViolation(error, 'payments_user_key_uq')) throw error
            const [existing] = await this.db
                .select()
                .from(payments)
                .where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, idempotencyKey)))
            if (!existing || existing.fingerprint !== fingerprint)
                throw new AppError('CONFLICT', 'The Idempotency-Key was used for another checkout')
            if (existing.checkoutUrl) return this.view(existing)
            payment = existing
        }

        const user = await this.users.recipient(userId)
        if (!user || user.status !== 'active') throw new AppError('FORBIDDEN', 'Account not active')
        try {
            const checkout = await this.provider.createCheckout({
                payment,
                email: user.email,
                locale: user.locale,
            })
            const [ready] = await this.db
                .update(payments)
                .set({
                    providerPaymentId: checkout.providerPaymentId,
                    checkoutUrl: checkout.checkoutUrl,
                    status: 'pending',
                    updatedAt: new Date(),
                })
                .where(eq(payments.id, payment.id))
                .returning()
            return this.view(ready ?? payment)
        } catch (error) {
            this.logger.warn(
                {
                    paymentId: payment.id,
                    err: (error as Error).message,
                },
                'Provider refused the checkout',
            )
            throw new AppError('UNAVAILABLE', 'Payment provider unavailable, retry later')
        }
    }

    async list(userId: string, limit: number, from?: string) {
        const after = from ? cursor.decode(from) : undefined
        const rows = await this.db
            .select()
            .from(payments)
            .where(
                and(
                    eq(payments.userId, userId),
                    after
                        ? or(
                              lt(payments.createdAt, new Date(after.createdAt)),
                              and(eq(payments.createdAt, new Date(after.createdAt)), lt(payments.id, after.id)),
                          )
                        : undefined,
                ),
            )
            .orderBy(desc(payments.createdAt), desc(payments.id))
            .limit(limit + 1)
        const page = rows.slice(0, limit)
        const last = page.at(-1)
        return {
            items: page.map(row => this.view(row)),
            nextCursor:
                rows.length > limit && last
                    ? cursor.encode({
                          createdAt: last.createdAt.toISOString(),
                          id: last.id,
                      })
                    : null,
        }
    }

    async get(userId: string, id: string) {
        const [row] = await this.db
            .select()
            .from(payments)
            .where(and(eq(payments.id, id), eq(payments.userId, userId)))
        if (!row) throw notFound('Payment')
        return this.view(row)
    }

    /**
     * A trusted provider fact → the payment, under its row lock. Paid once:
     * a later failure never undoes a success; the amount and the currency must
     * match the snapshot, otherwise nothing changes (mismatch, logged).
     */
    async apply(
        tx: Tx,
        fact: ProviderFact,
    ): Promise<{
        outcome: FactOutcome
        paymentId?: string
    }> {
        const [payment] = await tx
            .select()
            .from(payments)
            .where(
                and(eq(payments.provider, this.provider.name), eq(payments.providerPaymentId, fact.providerPaymentId)),
            )
            .for('update')
        if (!payment)
            return {
                outcome: 'unmatched',
            }
        if (payment.status === 'succeeded')
            return {
                outcome: 'ignored',
                paymentId: payment.id,
            }
        if (fact.outcome === 'failed') {
            await tx
                .update(payments)
                .set({
                    status: 'failed',
                    failureReason: 'provider',
                    updatedAt: new Date(),
                })
                .where(eq(payments.id, payment.id))
            return {
                outcome: 'processed',
                paymentId: payment.id,
            }
        }
        if (
            (fact.amount !== undefined && !sameMoney(fact.amount, payment.amount))
            || (fact.currency !== undefined && fact.currency !== payment.currency)
        ) {
            this.logger.error(
                {
                    paymentId: payment.id,
                },
                'Provider amount or currency differs from the order snapshot',
            )
            return {
                outcome: 'mismatch',
                paymentId: payment.id,
            }
        }
        const paidAt = new Date()
        await tx
            .update(payments)
            .set({
                status: 'succeeded',
                paidAt,
                updatedAt: paidAt,
            })
            .where(eq(payments.id, payment.id))
        await enqueueEvent(
            tx,
            paymentSucceeded.create({
                aggregateId: payment.id,
                payload: {
                    paymentId: payment.id,
                    userId: payment.userId,
                    productKey: payment.productKey,
                    coins: String(payment.coins),
                    amount: payment.amount,
                    currency: payment.currency,
                    provider: payment.provider,
                    paidAt: paidAt.toISOString(),
                },
            }),
        )
        return {
            outcome: 'processed',
            paymentId: payment.id,
        }
    }

    /** The fake provider's "pay" button: the same path as a webhook, for the payer only. */
    async completeFake(userId: string, id: string) {
        if (this.provider.name !== 'fake') throw notFound('Payment')
        const outcome = await this.db.transaction(async tx => {
            const [payment] = await tx
                .select()
                .from(payments)
                .where(and(eq(payments.id, id), eq(payments.userId, userId)))
            if (!payment?.providerPaymentId) throw notFound('Payment')
            return this.apply(tx, {
                providerPaymentId: payment.providerPaymentId,
                outcome: 'succeeded',
                amount: payment.amount,
                currency: payment.currency,
                dedupeKey: `fake:${payment.id}`,
            })
        })
        this.relay.kick()
        return {
            outcome: outcome.outcome,
            payment: await this.get(userId, id),
        }
    }

    view(row: PaymentRow) {
        return {
            id: row.id,
            productKey: row.productKey,
            coins: String(row.coins),
            amount: row.amount,
            currency: row.currency,
            provider: row.provider,
            status: row.status,
            checkoutUrl: row.status === 'pending' ? row.checkoutUrl : null,
            paidAt: row.paidAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        }
    }
}
