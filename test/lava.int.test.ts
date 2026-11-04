import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { payments } from '../src/db/schema.js'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'

const SECRET = 'l'.repeat(40)
let identity: Identity
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    t = await startApp(identity, {
        PAY_PROVIDER: 'lava',
        LAVA_API_KEY: 'api-key',
        LAVA_WEBHOOK_SECRET: SECRET,
    })
})
afterAll(async () => {
    await t?.close()
    await identity?.close()
})

/** A payment that Lava already has an invoice for. */
async function pendingPayment(amount = '499') {
    const contractId = `c-${randomUUID()}`
    const [row] = await t.db
        .insert(payments)
        .values({
            userId: randomUUID(),
            productKey: 'grm-550',
            grm: 550,
            amount,
            currency: 'RUB',
            provider: 'lava',
            providerPaymentId: contractId,
            checkoutUrl: 'https://pay.lava.top/x',
            status: 'pending',
            idempotencyKey: randomUUID(),
            fingerprint: 'x',
        })
        .returning()
    return {
        id: row?.id,
        contractId,
    }
}

const webhook = (key: string | undefined, body: Record<string, unknown>) => {
    const call = t.http().post('/webhooks/lava')
    return (key ? call.set('x-api-key', key) : call).send(body)
}

describe('Lava webhooks', () => {
    it('checks the credential before anything else', async () => {
        await webhook(undefined, {}).expect(401)
        await webhook('wrong', {}).expect(401)
    })

    it('applies a success once and publishes it', async () => {
        const payment = await pendingPayment()
        const body = {
            eventType: 'payment.success',
            contractId: payment.contractId,
            status: 'completed',
            amount: 499,
            currency: 'RUB',
        }
        const first = await webhook(SECRET, body).expect(200)
        expect(first.body.status).toBe('processed')
        const second = await webhook(SECRET, body).expect(200)
        expect(second.body.status).toBe('duplicate')
        const rows = await t.db.execute<{
            status: string
        }>(sql`select status from payments where id = ${payment.id}`)
        expect(rows.rows[0]?.status).toBe('succeeded')
        const events = await t.db.execute(
            sql`select 1 from outbox where type = 'pay.payment.succeeded.v1' and envelope->>'aggregateId' = ${payment.id}`,
        )
        expect(events.rows).toHaveLength(1)
    })

    it('does not pay out when the amount differs from the order snapshot', async () => {
        const payment = await pendingPayment('499')
        const response = await webhook(SECRET, {
            eventType: 'payment.success',
            contractId: payment.contractId,
            status: 'completed',
            amount: 1,
            currency: 'RUB',
        }).expect(200)
        expect(response.body.status).toBe('mismatch')
        const rows = await t.db.execute<{
            status: string
        }>(sql`select status from payments where id = ${payment.id}`)
        expect(rows.rows[0]?.status).toBe('pending')
    })

    it('records unknown payments and malformed bodies without failing', async () => {
        const unknown = await webhook(SECRET, {
            eventType: 'payment.success',
            contractId: 'never-seen',
            amount: 1,
        }).expect(200)
        expect(unknown.body.status).toBe('unmatched')
        const invalid = await webhook(SECRET, {
            hello: 'world',
        }).expect(200)
        expect(invalid.body.status).toBe('invalid')
    })
})
