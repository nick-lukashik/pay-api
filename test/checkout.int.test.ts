import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { payments } from '../src/db/schema.js'
import type { PaymentRow } from '../src/db/types.js'
import {
    type Checkout,
    type CheckoutInput,
    CheckoutRefused,
    type ParsedWebhook,
    PaymentProvider,
} from '../src/providers/provider.js'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'

/**
 * The fake provider with answers under the test's control: it counts the
 * invoices it creates and keeps them where `findCheckout` looks; `during` runs
 * while a create call is in flight (hold it, fail it).
 */
class ScriptedProvider extends PaymentProvider {
    readonly name = 'fake'
    readonly invoices = new Map<string, Checkout>()
    created = 0
    during: ((invoice: Checkout, payment: PaymentRow) => Promise<void>) | undefined

    async createCheckout({ payment }: CheckoutInput) {
        this.created += 1
        const invoice = {
            providerPaymentId: `inv-${this.created}-${payment.id}`,
            checkoutUrl: `https://pay.example.test/${this.created}/${payment.id}`,
        }
        this.invoices.set(payment.id, invoice)
        await this.during?.(invoice, payment)
        return invoice
    }

    async findCheckout(payment: PaymentRow) {
        return this.invoices.get(payment.id) ?? null
    }

    async lookup() {
        return undefined
    }

    authenticate() {
        return false
    }

    parse(): ParsedWebhook {
        return {
            rejected: 'no webhooks',
        }
    }
}

const provider = new ScriptedProvider()
let identity: Identity
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    t = await startApp(identity, {}, provider)
})
afterAll(async () => {
    await t?.close()
    await identity?.close()
})
beforeEach(() => {
    provider.during = undefined
})

async function buyer() {
    const userId = randomUUID()
    identity.users.set(userId, {
        id: userId,
        email: `${userId}@example.com`,
        locale: 'en',
        status: 'active',
    })
    return {
        token: await identity.token(userId),
        key: `checkout-${randomUUID()}`,
    }
}

/** A started request as a plain promise (supertest runs it on `then`). */
const checkout = (token: string, key: string) =>
    t
        .http()
        .post('/api/v1/me/checkout')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', key)
        .send({
            productKey: 'coins-550',
            currency: 'RUB',
        })
        .then(response => response)

const stored = async (key: string) => {
    const [row] = await t.db.select().from(payments).where(eq(payments.idempotencyKey, key))
    return row
}

describe('one provider checkout per payment', () => {
    it('creates one invoice for parallel requests with one key', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        const held = Promise.withResolvers<void>()
        provider.during = () => held.promise
        let answered = 0
        const requests = Array.from(
            {
                length: 8,
            },
            () =>
                checkout(token, key).then(response => {
                    answered += 1
                    return response
                }),
        )
        try {
            // Everyone but the executor answers while its provider call is held.
            await expect
                .poll(() => answered, {
                    timeout: 5_000,
                })
                .toBe(7)
        } finally {
            held.resolve()
        }
        const responses = await Promise.all(requests)

        expect(provider.created - before).toBe(1)
        expect(responses.map(response => response.status)).toEqual(Array(8).fill(200))
        expect(new Set(responses.map(response => response.body.id)).size).toBe(1)
        expect(responses.map(response => response.body.status).sort()).toEqual([
            ...Array(7).fill('creating'),
            'pending',
        ])
        const again = await checkout(token, key)
        expect(again.body).toMatchObject({
            status: 'pending',
            checkoutUrl: provider.invoices.get(again.body.id)?.checkoutUrl,
        })
    })

    it('finds the invoice of a lost answer instead of creating a second one', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        provider.during = async () => {
            throw new Error('socket hang up')
        }
        expect((await checkout(token, key)).status).toBe(503)
        expect((await stored(key))?.status).toBe('creating')

        provider.during = undefined
        const again = await checkout(token, key)
        expect(again.status).toBe(200)
        expect(provider.created - before).toBe(1)
        expect(again.body).toMatchObject({
            status: 'pending',
            checkoutUrl: provider.invoices.get(again.body.id)?.checkoutUrl,
        })
    })

    it('tries again after the provider refused', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        provider.during = async () => {
            throw new CheckoutRefused('Lava answered 400')
        }
        expect((await checkout(token, key)).status).toBe(503)
        expect((await stored(key))?.status).toBe('created')

        provider.during = undefined
        const again = await checkout(token, key)
        expect(again.body.status).toBe('pending')
        expect(provider.created - before).toBe(2)
    })

    it('never lets a late answer move the payment back or replace its invoice', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        const held = Promise.withResolvers<void>()
        provider.during = async (_invoice, payment) => {
            // Not visible at the provider yet, and answered only after everything below.
            provider.invoices.delete(payment.id)
            await held.promise
        }
        const late = checkout(token, key)
        await expect.poll(() => provider.created - before).toBe(1)

        // The executor is stuck past its claim: the next request takes over.
        await t.db
            .update(payments)
            .set({
                checkoutLeaseUntil: sql`now() - interval '1 second'`,
            })
            .where(eq(payments.idempotencyKey, key))
        provider.during = undefined
        const taken = await checkout(token, key)
        expect(taken.body.status).toBe('pending')
        expect(provider.created - before).toBe(2)
        const paid = await t
            .http()
            .post(`/api/v1/me/payments/${taken.body.id}/fake-complete`)
            .set('authorization', `Bearer ${token}`)
            .expect(200)
        expect(paid.body.payment.status).toBe('succeeded')

        held.resolve()
        const answer = await late
        expect(answer.body.status).toBe('succeeded')
        expect(await stored(key)).toMatchObject({
            status: 'succeeded',
            providerPaymentId: `inv-${before + 2}-${taken.body.id}`,
            checkoutUrl: taken.body.checkoutUrl,
        })
    })
})
