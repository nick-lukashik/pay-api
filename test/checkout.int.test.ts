import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REQUEST_TIMEOUT_MS } from '../src/common/http/request-timeout.js'
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
    /** `findCheckout` finds the invoice without its URL, as a provider's list may. */
    findsWithoutUrl = false

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
        const found = this.invoices.get(payment.id)
        if (!found) return null
        return this.findsWithoutUrl
            ? {
                  providerPaymentId: found.providerPaymentId,
              }
            : found
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
    provider.findsWithoutUrl = false
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
    it('creates one invoice for parallel requests with one key, and every request gets its URL', async () => {
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
        await expect.poll(() => provider.created - before).toBe(1)
        // Everyone waits for the executor's provider call instead of answering 'creating' at once.
        await new Promise(resolve => setTimeout(resolve, 1_000))
        expect(answered).toBe(0)
        held.resolve()
        const responses = await Promise.all(requests)

        expect(provider.created - before).toBe(1)
        expect(responses.map(response => response.status)).toEqual(Array(8).fill(200))
        const [first] = responses
        for (const response of responses)
            expect(response.body).toMatchObject({
                id: first?.body.id,
                status: 'pending',
                checkoutUrl: provider.invoices.get(first?.body.id)?.checkoutUrl,
            })
    })

    it('answers creating only after waiting, within the request budget, for a provider call that takes longer', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        const held = Promise.withResolvers<void>()
        provider.during = () => held.promise
        const executor = checkout(token, key)
        await expect.poll(() => provider.created - before).toBe(1)

        const started = performance.now()
        const waiting = await checkout(token, key)
        const waited = performance.now() - started
        expect(waiting.status).toBe(200)
        expect(waiting.body).toMatchObject({
            status: 'creating',
            checkoutUrl: null,
        })
        expect(waited).toBeGreaterThan(8_000)
        expect(waited).toBeLessThan(REQUEST_TIMEOUT_MS)

        held.resolve()
        const answer = await executor
        expect(answer.body.status).toBe('pending')
        expect((await checkout(token, key)).body).toMatchObject({
            status: 'pending',
            checkoutUrl: answer.body.checkoutUrl,
        })
        expect(provider.created - before).toBe(1)
    })

    it('takes over while waiting when the executor gives its claim back', async () => {
        const { token, key } = await buyer()
        const before = provider.created
        const held = Promise.withResolvers<void>()
        provider.during = async () => {
            await held.promise
            throw new CheckoutRefused('provider answered 400')
        }
        const executor = checkout(token, key)
        await expect.poll(() => provider.created - before).toBe(1)
        const waiting = checkout(token, key)
        await new Promise(resolve => setTimeout(resolve, 500))

        provider.during = undefined
        held.resolve()
        expect((await executor).status).toBe(503)
        expect((await waiting).body.status).toBe('pending')
        expect(provider.created - before).toBe(2)
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
            throw new CheckoutRefused('provider answered 400')
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

    describe('a late answer after the checkout was found without its URL', () => {
        /** The executor is stuck past its claim; the next request finds its invoice, without the URL. */
        const lostCheckout = async () => {
            const { token, key } = await buyer()
            const before = provider.created
            const held = Promise.withResolvers<void>()
            provider.during = () => held.promise
            const late = checkout(token, key)
            await expect.poll(() => provider.created - before).toBe(1)
            await t.db
                .update(payments)
                .set({
                    checkoutLeaseUntil: sql`now() - interval '1 second'`,
                })
                .where(eq(payments.idempotencyKey, key))
            provider.findsWithoutUrl = true
            const found = await checkout(token, key)
            expect(found.body).toMatchObject({
                status: 'failed',
                checkoutUrl: null,
            })
            expect(await stored(key)).toMatchObject({
                failureReason: 'checkout_lost',
                checkoutUrl: null,
            })
            return {
                key,
                invoice: provider.invoices.get(found.body.id),
                answer: () => {
                    held.resolve()
                    return late
                },
            }
        }

        it('brings the payment back to pending with that URL', async () => {
            const { key, invoice, answer } = await lostCheckout()
            expect((await answer()).body).toMatchObject({
                status: 'pending',
                checkoutUrl: invoice?.checkoutUrl,
            })
            expect(await stored(key)).toMatchObject({
                status: 'pending',
                failureReason: null,
                checkoutUrl: invoice?.checkoutUrl,
                providerPaymentId: invoice?.providerPaymentId,
            })
        })

        it('leaves a payment that failed at the provider failed', async () => {
            const { key, answer } = await lostCheckout()
            await t.db
                .update(payments)
                .set({
                    failureReason: 'provider',
                })
                .where(eq(payments.idempotencyKey, key))
            expect((await answer()).body.status).toBe('failed')
            expect(await stored(key)).toMatchObject({
                status: 'failed',
                failureReason: 'provider',
                checkoutUrl: null,
            })
        })

        it('ignores an answer about another invoice', async () => {
            const { key, answer } = await lostCheckout()
            await t.db
                .update(payments)
                .set({
                    providerPaymentId: `other-${randomUUID()}`,
                })
                .where(eq(payments.idempotencyKey, key))
            expect((await answer()).body.status).toBe('failed')
            expect(await stored(key)).toMatchObject({
                status: 'failed',
                checkoutUrl: null,
            })
        })
    })
})
