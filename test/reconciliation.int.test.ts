import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { paymentSucceededEvent } from '../src/checkout/payments.service.js'
import { outbox, payments } from '../src/db/schema.js'
import type { PaymentRow } from '../src/db/types.js'
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'
import { startWallet, type Wallet } from './wallet.js'

let identity: Identity
let wallet: Wallet
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    wallet = await startWallet(inject('rabbitmqUrl'))
    t = await startApp(identity, {
        WALLET_API_URL: wallet.url,
        WALLET_INTERNAL_TOKEN: wallet.internalToken,
    })
})
afterAll(async () => {
    await t?.close()
    await wallet?.close()
    await identity?.close()
})
beforeEach(async () => {
    wallet.answer = 'ok'
    // Every test starts with nothing due from the one before.
    await t.db.execute(sql`truncate payments, outbox`)
})

const round = () => t.app.get(ReconciliationService).round()

/** A payment paid `age` ago. */
async function paid(age = sql`interval '6 minutes'`) {
    const userId = randomUUID()
    const [row] = await t.db
        .insert(payments)
        .values({
            userId,
            productKey: 'coins-550',
            coins: 550,
            amount: '500',
            currency: 'RUB',
            provider: 'fake',
            status: 'succeeded',
            idempotencyKey: randomUUID(),
            fingerprint: 'x',
            paidAt: sql`now() - ${age}`,
        })
        .returning()
    if (!row) throw new Error('no payment')
    return row
}

/** The outbox row of `payment`, as the relay would have left it. */
const eventRow = (payment: PaymentRow) => ({
    eventId: payment.id,
    type: 'pay.payment.succeeded.v1',
    exchange: 'pay.events',
    envelope: paymentSucceededEvent(payment, payment.paidAt ?? new Date()),
})

/** The event of `payment` as it stands after it was published `age` ago (the row is kept for 7 days). */
const published = async (payment: PaymentRow, age = sql`interval '6 minutes'`) => {
    await t.db.insert(outbox).values({
        ...eventRow(payment),
        status: 'published',
        publishedAt: sql`now() - ${age}`,
    })
}

const stored = async (id: string) => {
    const [row] = await t.db.select().from(payments).where(eq(payments.id, id))
    return row
}

const eventRows = (id: string) => t.db.select().from(outbox).where(eq(outbox.eventId, id))

const results = async () => ({
    ok: await t.metric('payment_reconciliation_total', {
        result: 'ok',
    }),
    republished: await t.metric('payment_reconciliation_total', {
        result: 'republished',
    }),
    error: await t.metric('payment_reconciliation_total', {
        result: 'error',
    }),
})

const since = async (before: Awaited<ReturnType<typeof results>>) => {
    const now = await results()
    return {
        ok: now.ok - before.ok,
        republished: now.republished - before.republished,
        error: now.error - before.error,
    }
}

const deliveriesOf = (id: string) => wallet.deliveries.filter(delivery => delivery.paymentId === id)

describe('reconciliation with the ledger', () => {
    it('repairs a lost event once: one ledger operation, and the next rounds change nothing', async () => {
        const payment = await paid()
        const ref = `pack:payment:${payment.id}`
        await published(payment)
        const before = await results()

        // The broker lost the event: published, yet not in the ledger.
        expect(wallet.ledger.has(ref)).toBe(false)
        await round()
        expect(await since(before)).toEqual({
            ok: 0,
            republished: 1,
            error: 0,
        })
        await expect.poll(() => wallet.ledger.has(ref)).toBe(true)
        expect(deliveriesOf(payment.id)).toEqual([
            {
                eventId: payment.id,
                paymentId: payment.id,
            },
        ])
        expect((await stored(payment.id))?.reconciledAt).toBeNull()

        // The pack is in the ledger now: reconciled, nothing is sent again.
        await round()
        expect(await since(before)).toEqual({
            ok: 1,
            republished: 1,
            error: 0,
        })
        expect((await stored(payment.id))?.reconciledAt).toBeInstanceOf(Date)

        // Nothing due, so wallet-api is not even asked.
        const asked = wallet.asked
        await round()
        expect(wallet.asked).toBe(asked)
        expect(await since(before)).toEqual({
            ok: 1,
            republished: 1,
            error: 0,
        })
        expect(deliveriesOf(payment.id)).toHaveLength(1)
    })

    it('sends the event of a payment whose outbox row is purged, whole and with the same id', async () => {
        const payment = await paid()
        const before = await results()
        await round()
        expect((await since(before)).republished).toBe(1)
        await expect.poll(() => deliveriesOf(payment.id)).toHaveLength(1)
        const [row] = await eventRows(payment.id)
        expect(row).toMatchObject({
            type: 'pay.payment.succeeded.v1',
            exchange: 'pay.events',
            envelope: {
                eventId: payment.id,
                aggregateId: payment.id,
                occurredAt: payment.paidAt?.toISOString(),
                payload: {
                    paymentId: payment.id,
                    userId: payment.userId,
                    productKey: 'coins-550',
                    coins: '550',
                    amount: '500',
                    currency: 'RUB',
                    provider: 'fake',
                    paidAt: payment.paidAt?.toISOString(),
                },
            },
        })
    })

    it('marks a payment reconciled when the pack is already in the ledger, without sending anything', async () => {
        const payment = await paid()
        wallet.ledger.add(`pack:payment:${payment.id}`)
        const before = await results()
        await round()
        expect(await since(before)).toEqual({
            ok: 1,
            republished: 0,
            error: 0,
        })
        expect((await stored(payment.id))?.reconciledAt).toBeInstanceOf(Date)
        expect(await eventRows(payment.id)).toEqual([])
    })

    it('leaves a payment inside the grace period alone', async () => {
        const payment = await paid(sql`interval '1 minute'`)
        const asked = wallet.asked
        const before = await results()
        await round()
        expect(wallet.asked).toBe(asked)
        expect(await since(before)).toEqual({
            ok: 0,
            republished: 0,
            error: 0,
        })
        expect(await eventRows(payment.id)).toEqual([])
        expect(await t.metric('payments_unreconciled')).toBe(0)
    })

    it('does not send again what is still on its way', async () => {
        // Not published yet: the relay has it, for as long as the broker takes.
        const waiting = await paid()
        await t.db.insert(outbox).values({
            ...eventRow(waiting),
            availableAt: sql`now() + interval '1 hour'`,
        })
        // Published a moment ago, by the last round.
        const recent = await paid()
        await published(recent, sql`interval '1 minute'`)
        const before = await results()

        await round()
        expect(await since(before)).toEqual({
            ok: 0,
            republished: 0,
            error: 0,
        })
        expect(await eventRows(waiting.id)).toMatchObject([
            {
                status: 'pending',
            },
        ])
        expect(await eventRows(recent.id)).toMatchObject([
            {
                status: 'published',
            },
        ])
        expect(await t.metric('payments_unreconciled')).toBe(2)
    })

    it.each([
        'unavailable',
        'refused',
        'malformed',
    ] as const)('changes nothing and counts an error when wallet-api is %s, then recovers', async answer => {
        const payment = await paid()
        await published(payment)
        wallet.answer = answer
        const before = await results()

        await round()
        expect(await since(before)).toEqual({
            ok: 0,
            republished: 0,
            error: 1,
        })
        expect((await stored(payment.id))?.reconciledAt).toBeNull()
        expect(await eventRows(payment.id)).toMatchObject([
            {
                status: 'published',
            },
        ])
        expect(deliveriesOf(payment.id)).toEqual([])
        expect(await t.metric('payments_unreconciled')).toBe(1)

        wallet.answer = 'ok'
        wallet.ledger.add(`pack:payment:${payment.id}`)
        await round()
        expect((await stored(payment.id))?.reconciledAt).toBeInstanceOf(Date)
        expect(await t.metric('payments_unreconciled')).toBe(0)
    })

    it('leaves the round to the pod that holds the lock', async () => {
        const payment = await paid()
        const asked = wallet.asked
        const release = Promise.withResolvers<void>()
        const locked = Promise.withResolvers<void>()
        const holder = t.db.transaction(async tx => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pay-api:reconciliation', 0))`)
            locked.resolve()
            await release.promise
        })
        await locked.promise
        await round()
        expect(wallet.asked).toBe(asked)
        expect((await stored(payment.id))?.reconciledAt).toBeNull()
        release.resolve()
        await holder

        await round()
        expect(wallet.asked).toBe(asked + 1)
    })

    it('goes through every due payment, past a full batch', async () => {
        const rows = await t.db
            .insert(payments)
            .values(
                Array.from(
                    {
                        length: 205,
                    },
                    () => ({
                        userId: randomUUID(),
                        productKey: 'coins-550',
                        coins: 550,
                        amount: '500',
                        currency: 'RUB' as const,
                        provider: 'fake',
                        status: 'succeeded' as const,
                        idempotencyKey: randomUUID(),
                        fingerprint: 'x',
                        paidAt: sql`now() - interval '6 minutes'`,
                    }),
                ),
            )
            .returning()
        for (const row of rows) wallet.ledger.add(`pack:payment:${row.id}`)
        const asked = wallet.asked
        expect(await t.metric('payments_unreconciled')).toBe(205)
        await round()
        expect(wallet.asked - asked).toBe(2)
        expect(await t.metric('payments_unreconciled')).toBe(0)
    })

    it('makes the event of a settled payment carry the id of the payment', async () => {
        const userId = randomUUID()
        identity.users.set(userId, {
            id: userId,
            email: `${userId}@example.com`,
            locale: 'en',
            status: 'active',
        })
        const token = await identity.token(userId)
        const created = await t
            .http()
            .post('/api/v1/me/checkout')
            .set('authorization', `Bearer ${token}`)
            .set('idempotency-key', `checkout-${randomUUID()}`)
            .send({
                productKey: 'coins-100',
            })
            .expect(200)
        await t
            .http()
            .post(`/api/v1/me/payments/${created.body.id}/fake-complete`)
            .set('authorization', `Bearer ${token}`)
            .expect(200)
        await expect.poll(() => deliveriesOf(created.body.id)).toHaveLength(1)
        expect(deliveriesOf(created.body.id)[0]?.eventId).toBe(created.body.id)
        expect(wallet.ledger.has(`pack:payment:${created.body.id}`)).toBe(true)
    })
})
