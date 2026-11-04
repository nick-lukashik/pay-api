import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { payments, webhookEvents } from '../src/db/schema.js'
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'
import { type LavaApi, startLavaApi } from './lava-api.js'

const SECRET = 'l'.repeat(40)
const API_KEY = 'api-key'
const OFFER = randomUUID()
let identity: Identity
let lava: LavaApi
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    lava = await startLavaApi(API_KEY)
    t = await startApp(identity, {
        PAY_PROVIDER: 'lava',
        LAVA_API_URL: lava.url,
        LAVA_API_KEY: API_KEY,
        LAVA_WEBHOOK_SECRET: SECRET,
        LAVA_OFFER_COINS_550: OFFER,
    })
})
afterAll(async () => {
    await t?.close()
    await lava?.close()
    await identity?.close()
})

/** A payment that Lava already has an invoice for. */
async function pendingPayment(contractId = `c-${randomUUID()}`) {
    const [row] = await t.db
        .insert(payments)
        .values({
            userId: randomUUID(),
            productKey: 'coins-550',
            coins: 550,
            amount: '500',
            currency: 'RUB',
            provider: 'lava',
            providerPaymentId: contractId,
            checkoutUrl: 'https://pay.lava.top/x',
            status: 'pending',
            idempotencyKey: randomUUID(),
            fingerprint: 'x',
        })
        .returning()
    if (!row) throw new Error('no payment')
    return {
        id: row.id,
        contractId,
    }
}

async function buyer() {
    const userId = randomUUID()
    identity.users.set(userId, {
        id: userId,
        email: `${userId}@example.com`,
        locale: 'ru',
        status: 'active',
    })
    return {
        userId,
        token: await identity.token(userId),
        key: `checkout-${randomUUID()}`,
    }
}

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

const webhook = (key: string | undefined, body: Record<string, unknown>) => {
    const call = t.http().post('/webhooks/lava')
    return (key ? call.set('x-api-key', key) : call).send(body)
}

const success = (contractId: string, money: Record<string, unknown>) => ({
    eventType: 'payment.success',
    contractId,
    status: 'completed',
    ...money,
})

const statusOf = async (id: string) => {
    const [row] = await t.db
        .select({
            status: payments.status,
        })
        .from(payments)
        .where(eq(payments.id, id))
    return row?.status
}

const credits = async (paymentId: string) => {
    const events = await t.db.execute(
        sql`select 1 from outbox where type = 'pay.payment.succeeded.v1' and envelope->>'aggregateId' = ${paymentId}`,
    )
    return events.rows.length
}

const webhooks = (result: string) =>
    t.metric('payment_webhooks_total', {
        result,
    })

const recordedWebhooks = async (contractId: string) => {
    const rows = await t.db.select().from(webhookEvents).where(eq(webhookEvents.providerPaymentId, contractId))
    return rows.length
}

describe('Lava checkout', () => {
    it('sends the offer, the currency and our payment id', async () => {
        const { token, key, userId } = await buyer()
        const response = await checkout(token, key)
        expect(response.status).toBe(200)
        const invoice = [
            ...lava.invoices.values(),
        ].find(item => item.clientUtm?.utm_content === response.body.id)
        expect(invoice).toMatchObject({
            offerId: OFFER,
            currency: 'RUB',
            email: `${userId}@example.com`,
        })
        expect(response.body).toMatchObject({
            status: 'pending',
            checkoutUrl: `https://pay.lava.top/${invoice?.id}`,
        })
    })

    it('refuses a product without an offer, and creates nothing', async () => {
        const { token, key } = await buyer()
        const before = lava.created
        const response = await t
            .http()
            .post('/api/v1/me/checkout')
            .set('authorization', `Bearer ${token}`)
            .set('idempotency-key', key)
            .send({
                productKey: 'coins-100',
                currency: 'RUB',
            })
        expect(response.status).toBe(503)
        expect(lava.created - before).toBe(0)
        const [row] = await t.db.select().from(payments).where(eq(payments.idempotencyKey, key))
        expect(row?.status).toBe('created')
    })

    it('finds the invoice of a lost answer by our payment id instead of creating a second one', async () => {
        const { token, key } = await buyer()
        const before = lava.created
        lava.onCreate = async () => 'drop'
        try {
            expect((await checkout(token, key)).status).toBe(503)
        } finally {
            lava.onCreate = undefined
        }
        const again = await checkout(token, key)
        expect(again.status).toBe(200)
        expect(lava.created - before).toBe(1)
        // Lava's list has no payment URL: nobody can pay that invoice, the buyer starts over.
        expect(again.body).toMatchObject({
            status: 'failed',
            checkoutUrl: null,
        })
        const [row] = await t.db.select().from(payments).where(eq(payments.id, again.body.id))
        const invoice = [
            ...lava.invoices.values(),
        ].find(item => item.clientUtm?.utm_content === again.body.id)
        expect(row).toMatchObject({
            providerPaymentId: invoice?.id,
            failureReason: 'checkout_lost',
        })
    })
})

describe('Lava webhooks', () => {
    it('answers 404 under any name but the active provider, whatever the credential', async () => {
        const before = await webhooks('rejected')
        await t.http().post('/webhooks/fake').set('x-api-key', SECRET).send({}).expect(404)
        await t.http().post('/webhooks/fake').send({}).expect(404)
        await t.http().post('/webhooks/stripe').set('x-api-key', SECRET).send({}).expect(404)
        await t.http().post('/webhooks/LAVA').set('x-api-key', SECRET).send({}).expect(404)
        expect((await webhooks('rejected')) - before).toBe(0)
    })

    it('checks the credential before anything else', async () => {
        const before = await webhooks('rejected')
        await webhook(undefined, {}).expect(401)
        await webhook('wrong', {}).expect(401)
        expect((await webhooks('rejected')) - before).toBe(2)
    })

    it('applies a success once and publishes it', async () => {
        const payment = await pendingPayment()
        const body = success(payment.contractId, {
            amount: 500,
            currency: 'RUB',
        })
        const first = await webhook(SECRET, body).expect(200)
        expect(first.body.status).toBe('applied')
        const second = await webhook(SECRET, body).expect(200)
        expect(second.body.status).toBe('duplicate')
        expect(await statusOf(payment.id)).toBe('succeeded')
        expect(await credits(payment.id)).toBe(1)
    })

    it('applies a webhook that came before the checkout answer, once', async () => {
        const { token, key } = await buyer()
        const held = Promise.withResolvers<'answer'>()
        let contractId = ''
        lava.onCreate = invoice => {
            contractId = invoice.id
            return held.promise
        }
        const before = {
            unmatched: await webhooks('unmatched'),
            applied: await webhooks('applied'),
            duplicate: await webhooks('duplicate'),
        }
        const started = checkout(token, key)
        try {
            await expect.poll(() => contractId).not.toBe('')
            const body = success(contractId, {
                amount: 500,
                currency: 'RUB',
            })
            expect((await webhook(SECRET, body).expect(200)).body.status).toBe('unmatched')
            // A retry of an event not applied yet is not a duplicate: it is tried again.
            expect((await webhook(SECRET, body).expect(200)).body.status).toBe('unmatched')
        } finally {
            held.resolve('answer')
            lava.onCreate = undefined
        }
        const answer = await started
        expect(answer.status).toBe(200)
        expect(answer.body.status).toBe('succeeded')
        expect(await credits(answer.body.id)).toBe(1)

        const repeat = await webhook(
            SECRET,
            success(contractId, {
                amount: 500,
                currency: 'RUB',
            }),
        ).expect(200)
        expect(repeat.body.status).toBe('duplicate')
        expect(await credits(answer.body.id)).toBe(1)
        expect({
            unmatched: (await webhooks('unmatched')) - before.unmatched,
            applied: (await webhooks('applied')) - before.applied,
            duplicate: (await webhooks('duplicate')) - before.duplicate,
        }).toEqual({
            unmatched: 2,
            applied: 1,
            duplicate: 1,
        })
    })

    it('applies a failure, and a later success still pays', async () => {
        const payment = await pendingPayment()
        const failed = await webhook(SECRET, {
            eventType: 'payment.failed',
            contractId: payment.contractId,
            status: 'failed',
        }).expect(200)
        expect(failed.body.status).toBe('applied')
        expect(await statusOf(payment.id)).toBe('failed')
        await webhook(
            SECRET,
            success(payment.contractId, {
                amount: 500,
                currency: 'RUB',
            }),
        ).expect(200)
        expect(await statusOf(payment.id)).toBe('succeeded')
    })
})

describe('Lava money checks', () => {
    it.each([
        [
            'another amount',
            {
                amount: 1,
                currency: 'RUB',
            },
        ],
        [
            'another currency',
            {
                amount: 500,
                currency: 'USD',
            },
        ],
    ])('does not pay out for %s', async (_case, money) => {
        const payment = await pendingPayment()
        const response = await webhook(SECRET, success(payment.contractId, money)).expect(200)
        expect(response.body.status).toBe('mismatch')
        expect(await statusOf(payment.id)).toBe('pending')
    })

    it.each([
        499.999,
        500.001,
        '500.001',
        '5e2',
        '500 ',
        '-500',
        '0x1F4',
        '500,00',
        '',
    ])('rejects the amount %j instead of rounding or coercing it', async amount => {
        const payment = await pendingPayment()
        const response = await webhook(
            SECRET,
            success(payment.contractId, {
                amount,
                currency: 'RUB',
            }),
        ).expect(200)
        expect(response.body.status).toBe('rejected')
        expect(await statusOf(payment.id)).toBe('pending')
    })

    it('rejects a currency we do not sell', async () => {
        const payment = await pendingPayment()
        const response = await webhook(
            SECRET,
            success(payment.contractId, {
                amount: 500,
                currency: 'rub',
            }),
        ).expect(200)
        expect(response.body.status).toBe('rejected')
    })

    it('asks Lava when the webhook leaves out the currency', async () => {
        const paid = await pendingPayment(
            lava.add({
                status: 'COMPLETED',
                amount: 500,
                currency: 'RUB',
            }),
        )
        const applied = await webhook(
            SECRET,
            success(paid.contractId, {
                amount: 500,
            }),
        ).expect(200)
        expect(applied.body.status).toBe('applied')
        expect(await statusOf(paid.id)).toBe('succeeded')

        // The webhook says 500, Lava's own record says 1: Lava's record decides.
        const cheaper = await pendingPayment(
            lava.add({
                status: 'COMPLETED',
                amount: 1,
                currency: 'RUB',
            }),
        )
        const mismatch = await webhook(
            SECRET,
            success(cheaper.contractId, {
                amount: 500,
            }),
        ).expect(200)
        expect(mismatch.body.status).toBe('mismatch')
        expect(await statusOf(cheaper.id)).toBe('pending')
    })

    it('asks Lava when the webhook leaves out the amount', async () => {
        const payment = await pendingPayment(
            lava.add({
                status: 'COMPLETED',
                amount: 500,
                currency: 'RUB',
            }),
        )
        const response = await webhook(
            SECRET,
            success(payment.contractId, {
                currency: 'RUB',
            }),
        ).expect(200)
        expect(response.body.status).toBe('applied')
    })

    it('asks Lava to retry a success its own record does not show yet, then applies it', async () => {
        const contractId = randomUUID()
        const payment = await pendingPayment(contractId)
        const body = success(contractId, {})
        const rejected = await webhooks('rejected')

        // No such invoice at Lava yet (404): nothing is recorded, so the retry is not a duplicate.
        await webhook(SECRET, body).expect(503)
        expect(await recordedWebhooks(contractId)).toBe(0)
        expect((await webhooks('rejected')) - rejected).toBe(0)
        expect(await statusOf(payment.id)).toBe('pending')

        lava.invoices.set(contractId, {
            id: contractId,
            status: 'COMPLETED',
            amount: 500,
            currency: 'RUB',
        })
        expect((await webhook(SECRET, body).expect(200)).body.status).toBe('applied')
        expect(await statusOf(payment.id)).toBe('succeeded')
        expect(await credits(payment.id)).toBe(1)
    })

    it('counts a deferred success on every try, and logs its provider id, not its payload', async () => {
        const contractId = randomUUID()
        const payment = await pendingPayment(contractId)
        const body = success(contractId, {
            buyer: 'nobody-may-log-this@example.com',
        })
        const warn = vi.spyOn(Logger.prototype, 'warn')
        const deferred = await webhooks('deferred')

        await webhook(SECRET, body).expect(503)
        expect((await webhooks('deferred')) - deferred).toBe(1)
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                providerPaymentId: contractId,
            }),
            expect.any(String),
        )
        expect(JSON.stringify(warn.mock.calls)).not.toContain('nobody-may-log-this')
        expect(await recordedWebhooks(contractId)).toBe(0)

        await webhook(SECRET, body).expect(503)
        expect((await webhooks('deferred')) - deferred).toBe(2)

        lava.invoices.set(contractId, {
            id: contractId,
            status: 'COMPLETED',
            amount: 500,
            currency: 'RUB',
        })
        const applied = await webhooks('applied')
        expect((await webhook(SECRET, body).expect(200)).body.status).toBe('applied')
        expect((await webhooks('applied')) - applied).toBe(1)
        expect((await webhooks('deferred')) - deferred).toBe(2)
        expect(await statusOf(payment.id)).toBe('succeeded')
    })

    it('counts as deferred a success it cannot ask Lava about, and keeps the 503', async () => {
        const contractId = lava.add({
            status: 'COMPLETED',
            amount: 500,
            currency: 'RUB',
        })
        const payment = await pendingPayment(contractId)
        const body = success(contractId, {})
        const warn = vi.spyOn(Logger.prototype, 'warn')
        const deferred = await webhooks('deferred')

        lava.answer = 'unavailable'
        try {
            await webhook(SECRET, body).expect(503)
        } finally {
            lava.answer = 'ok'
        }
        expect((await webhooks('deferred')) - deferred).toBe(1)
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                providerPaymentId: contractId,
            }),
            expect.any(String),
        )
        expect(await recordedWebhooks(contractId)).toBe(0)
        expect(await statusOf(payment.id)).toBe('pending')

        expect((await webhook(SECRET, body).expect(200)).body.status).toBe('applied')
    })

    it('asks Lava to retry a success its record contradicts or leaves without the money', async () => {
        const failed = await pendingPayment(
            lava.add({
                status: 'FAILED',
                currency: 'RUB',
            }),
        )
        await webhook(SECRET, success(failed.contractId, {})).expect(503)
        expect(await recordedWebhooks(failed.contractId)).toBe(0)
        expect(await statusOf(failed.id)).toBe('pending')

        const noCurrency = await pendingPayment(
            lava.add({
                status: 'COMPLETED',
                amount: 500,
                currency: 'XXX',
            }),
        )
        await webhook(SECRET, success(noCurrency.contractId, {})).expect(503)
        expect(await recordedWebhooks(noCurrency.contractId)).toBe(0)
        expect(await statusOf(noCurrency.id)).toBe('pending')

        // Lava's record catches up: the same event pays.
        Object.assign(lava.invoices.get(failed.contractId) ?? {}, {
            status: 'COMPLETED',
            amount: 500,
        })
        expect((await webhook(SECRET, success(failed.contractId, {})).expect(200)).body.status).toBe('applied')
        expect(await statusOf(failed.id)).toBe('succeeded')
    })

    it('asks Lava to retry while its invoice is not settled yet', async () => {
        const contractId = lava.add({
            status: 'IN_PROGRESS',
            currency: 'RUB',
        })
        const payment = await pendingPayment(contractId)
        const body = success(contractId, {})
        await webhook(SECRET, body).expect(503)
        Object.assign(lava.invoices.get(contractId) ?? {}, {
            status: 'COMPLETED',
            amount: 500,
        })
        expect((await webhook(SECRET, body).expect(200)).body.status).toBe('applied')
        expect(await statusOf(payment.id)).toBe('succeeded')
    })

    it('records unknown payments and malformed bodies without failing', async () => {
        const unknown = await webhook(
            SECRET,
            success('never-seen', {
                amount: 1,
                currency: 'RUB',
            }),
        ).expect(200)
        expect(unknown.body.status).toBe('unmatched')
        const invalid = await webhook(SECRET, {
            hello: 'world',
        }).expect(200)
        expect(invalid.body.status).toBe('rejected')
    })
})

describe('Lava payments whose webhook never came', () => {
    /** A payment past the 10 minutes, whose invoice is `contractId`. */
    const unconfirmed = async (contractId: string) => {
        const payment = await pendingPayment(contractId)
        await t.db
            .update(payments)
            .set({
                createdAt: sql`now() - interval '11 minutes'`,
            })
            .where(eq(payments.id, payment.id))
        return payment
    }

    const round = () => t.app.get(ReconciliationService).round()

    const sync = (result: string) =>
        t.metric('payment_provider_sync_total', {
            result,
        })

    it('pays by the record of Lava, and a late webhook is a duplicate', async () => {
        const payment = await unconfirmed(
            lava.add({
                status: 'COMPLETED',
                amount: 500,
                currency: 'RUB',
            }),
        )
        const applied = await sync('applied')
        await round()
        expect(await statusOf(payment.id)).toBe('succeeded')
        expect((await sync('applied')) - applied).toBe(1)
        expect(await credits(payment.id)).toBe(1)

        const late = await webhook(
            SECRET,
            success(payment.contractId, {
                amount: 500,
                currency: 'RUB',
            }),
        ).expect(200)
        expect(late.body.status).toBe('duplicate')
        expect(await credits(payment.id)).toBe(1)
    })

    it('does not pay when the record of Lava shows other money', async () => {
        const payment = await unconfirmed(
            lava.add({
                status: 'COMPLETED',
                amount: 499.99,
                currency: 'RUB',
            }),
        )
        const mismatch = await sync('mismatch')
        await round()
        expect(await statusOf(payment.id)).toBe('pending')
        expect((await sync('mismatch')) - mismatch).toBe(1)
        expect(await credits(payment.id)).toBe(0)
    })

    it('fails on a failed invoice, and changes nothing on an open one or a missing one', async () => {
        const failed = await unconfirmed(
            lava.add({
                status: 'FAILED',
                currency: 'RUB',
            }),
        )
        const open = await unconfirmed(
            lava.add({
                status: 'IN_PROGRESS',
                currency: 'RUB',
            }),
        )
        const missing = await unconfirmed(`c-${randomUUID()}`)
        const before = {
            open: await sync('open'),
            missing: await sync('missing'),
        }
        await round()
        expect(await statusOf(failed.id)).toBe('failed')
        expect(await statusOf(open.id)).toBe('pending')
        expect(await statusOf(missing.id)).toBe('pending')
        expect((await sync('open')) - before.open).toBe(1)
        expect((await sync('missing')) - before.missing).toBe(1)
    })

    it('changes nothing and counts an error while Lava is down', async () => {
        const payment = await unconfirmed(
            lava.add({
                status: 'COMPLETED',
                amount: 500,
                currency: 'RUB',
            }),
        )
        const errors = await sync('error')
        lava.answer = 'unavailable'
        try {
            await round()
        } finally {
            lava.answer = 'ok'
        }
        expect(await statusOf(payment.id)).toBe('pending')
        expect(await sync('error')).toBeGreaterThan(errors)

        await round()
        expect(await statusOf(payment.id)).toBe('succeeded')
    })
})
