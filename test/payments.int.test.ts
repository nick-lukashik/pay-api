import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'

let identity: Identity
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    t = await startApp(identity)
})
afterAll(async () => {
    await t?.close()
    await identity?.close()
})

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
    }
}

const checkout = (token: string, key: string | undefined, body: Record<string, unknown>) => {
    const call = t.http().post('/api/v1/me/checkout').set('authorization', `Bearer ${token}`)
    return (key ? call.set('idempotency-key', key) : call).send(body)
}

describe('catalog and checkout', () => {
    it('lists the coin packs', async () => {
        const response = await t.http().get('/api/v1/catalog').expect(200)
        expect(response.body.items.map((item: { key: string }) => item.key)).toEqual([
            'coins-100',
            'coins-550',
            'coins-1200',
        ])
    })

    it('creates one payment per idempotency key from the server-side price', async () => {
        const { token } = await buyer()
        const key = `checkout-${randomUUID()}`
        const first = await checkout(token, key, {
            productKey: 'coins-550',
            currency: 'RUB',
        }).expect(200)
        expect(first.body).toMatchObject({
            productKey: 'coins-550',
            coins: '550',
            amount: '500',
            currency: 'RUB',
            status: 'pending',
            checkoutUrl: `https://id.example.test/payments/fake/${first.body.id}`,
        })
        const again = await checkout(token, key, {
            productKey: 'coins-550',
            currency: 'RUB',
        }).expect(200)
        expect(again.body.id).toBe(first.body.id)
        await checkout(token, key, {
            productKey: 'coins-100',
            currency: 'RUB',
        }).expect(409)
        await checkout(token, undefined, {
            productKey: 'coins-100',
        }).expect(400)
        await checkout(token, `checkout-${randomUUID()}`, {
            productKey: 'coins-9999',
        }).expect(400)
    })
})

describe('confirmation', () => {
    it('confirms a fake payment once and publishes it; strangers get 404', async () => {
        const { userId, token } = await buyer()
        const created = await checkout(token, `checkout-${randomUUID()}`, {
            productKey: 'coins-100',
        }).expect(200)
        const stranger = await buyer()
        await t
            .http()
            .post(`/api/v1/me/payments/${created.body.id}/fake-complete`)
            .set('authorization', `Bearer ${stranger.token}`)
            .expect(404)

        const done = await t
            .http()
            .post(`/api/v1/me/payments/${created.body.id}/fake-complete`)
            .set('authorization', `Bearer ${token}`)
            .expect(200)
        expect(done.body.outcome).toBe('processed')
        expect(done.body.payment.status).toBe('succeeded')
        const repeat = await t
            .http()
            .post(`/api/v1/me/payments/${created.body.id}/fake-complete`)
            .set('authorization', `Bearer ${token}`)
            .expect(200)
        expect(repeat.body.outcome).toBe('ignored')

        const events = await t.db.execute<{
            envelope: {
                payload: {
                    userId: string
                    coins: string
                }
            }
        }>(sql`select envelope from outbox where type = 'pay.payment.succeeded.v1'`)
        const mine = events.rows.filter(row => row.envelope.payload.userId === userId)
        expect(mine).toHaveLength(1)
        expect(mine[0]?.envelope.payload.coins).toBe('100')

        const history = await t.http().get('/api/v1/me/payments').set('authorization', `Bearer ${token}`).expect(200)
        expect(history.body.items[0]).toMatchObject({
            id: created.body.id,
            status: 'succeeded',
            checkoutUrl: null,
        })
    })

    it('accepts no webhooks for the fake provider and none for unknown ones', async () => {
        await t.http().post('/webhooks/fake').send({}).expect(401)
        await t.http().post('/webhooks/stripe').send({}).expect(404)
    })
})
