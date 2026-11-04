import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { eq, type SQL, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentsService } from '../src/checkout/payments.service.js'
import { outbox, payments, webhookEvents } from '../src/db/schema.js'
import {
    type Checkout,
    CheckoutRefused,
    type ParsedWebhook,
    PaymentProvider,
    type ProviderRecord,
} from '../src/providers/provider.js'
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js'
import { startApp, type TestApp } from './harness.js'
import { type Identity, startIdentity } from './identity.js'

/** A provider whose records are under the test's control; `during` runs while a lookup is in flight. */
class ScriptedProvider extends PaymentProvider {
    readonly name = 'scripted'
    readonly records = new Map<string, ProviderRecord | Error>()
    asked: string[] = []
    during: (() => Promise<void>) | undefined

    async createCheckout(): Promise<Checkout> {
        throw new CheckoutRefused('no checkouts here')
    }

    async findCheckout() {
        return null
    }

    async lookup(providerPaymentId: string) {
        this.asked.push(providerPaymentId)
        await this.during?.()
        const record = this.records.get(providerPaymentId)
        if (record instanceof Error) throw record
        return record
    }

    authenticate() {
        return true
    }

    /** The webhook's body is the fact. */
    parse(payload: unknown): ParsedWebhook {
        const { amountMinor, ...fact } = payload as {
            providerPaymentId: string
            outcome: 'succeeded' | 'failed'
            amountMinor: string
            currency: 'RUB'
            dedupeKey: string
        }
        return {
            fact: {
                ...fact,
                amountMinor: BigInt(amountMinor),
            },
        }
    }
}

const provider = new ScriptedProvider()
let identity: Identity
let t: TestApp

beforeAll(async () => {
    identity = await startIdentity()
    t = await startApp(
        identity,
        {
            // A ledger nobody can reach: the sync must not depend on it.
            WALLET_API_URL: 'http://127.0.0.1:1',
        },
        provider,
    )
})
afterAll(async () => {
    await t?.close()
    await identity?.close()
})
beforeEach(async () => {
    provider.records.clear()
    provider.asked = []
    provider.during = undefined
    await t.db.execute(sql`truncate payments, webhook_events, outbox`)
})

const round = (app = t) => app.app.get(ReconciliationService).round()

type Values = {
    [Column in keyof typeof payments.$inferInsert]?: (typeof payments.$inferInsert)[Column] | SQL
}

const row = (values: Values = {}) => ({
    userId: randomUUID(),
    productKey: 'coins-550',
    coins: 550,
    amount: '500',
    currency: 'RUB' as const,
    provider: provider.name,
    providerPaymentId: `p-${randomUUID()}`,
    checkoutUrl: 'https://pay.example.test/x',
    status: 'pending' as const,
    idempotencyKey: randomUUID(),
    fingerprint: 'x',
    createdAt: sql`now() - interval '11 minutes'`,
    ...values,
})

/** A payment past the 10 minutes, or as `values` say. */
async function pending(values: Values = {}) {
    const [created] = await t.db.insert(payments).values(row(values)).returning()
    if (!created) throw new Error('no payment')
    return created as typeof created & {
        providerPaymentId: string
    }
}

const paid = (providerPaymentId: string, amountMinor = 50_000n, currency: 'RUB' | 'USD' = 'RUB'): ProviderRecord => ({
    providerPaymentId,
    outcome: 'succeeded',
    amountMinor,
    currency,
})

const stored = async (id: string) => {
    const [found] = await t.db.select().from(payments).where(eq(payments.id, id))
    if (!found) throw new Error('no payment')
    return found
}

const eventsOf = (id: string) => t.db.select().from(outbox).where(eq(outbox.eventId, id))
const factsOf = (id: string) => t.db.select().from(webhookEvents).where(eq(webhookEvents.paymentId, id))

const RESULTS = [
    'applied',
    'open',
    'missing',
    'mismatch',
    'error',
] as const

const results = async (app = t) =>
    Object.fromEntries(
        await Promise.all(
            RESULTS.map(
                async result =>
                    [
                        result,
                        await app.metric('payment_provider_sync_total', {
                            result,
                        }),
                    ] as const,
            ),
        ),
    ) as Record<(typeof RESULTS)[number], number>

/** The results since `before`: only the ones that moved. */
const since = async (before: Awaited<ReturnType<typeof results>>) => {
    const now = await results()
    return Object.fromEntries(
        RESULTS.map(result => [
            result,
            now[result] - before[result],
        ]).filter(([, delta]) => delta !== 0),
    )
}

const webhook = (providerPaymentId: string, dedupeKey: string) =>
    t.http().post(`/webhooks/${provider.name}`).send({
        providerPaymentId,
        outcome: 'succeeded',
        amountMinor: '50000',
        currency: 'RUB',
        dedupeKey,
    })

describe('a payment whose webhook never came', () => {
    it('is paid once by the record of the provider, through the path of a webhook', async () => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        const before = await results()
        const webhooksBefore = await t.metric('payment_webhooks_total')

        await round()

        expect(await stored(payment.id)).toMatchObject({
            status: 'succeeded',
            paidAt: expect.any(Date),
        })
        expect(await since(before)).toEqual({
            applied: 1,
        })
        expect(await eventsOf(payment.id)).toHaveLength(1)
        expect(await factsOf(payment.id)).toMatchObject([
            {
                provider: provider.name,
                dedupeKey: `sync:${payment.id}:succeeded`,
                outcome: 'processed',
                providerPaymentId: payment.providerPaymentId,
                paymentStatus: 'succeeded',
                amountMinor: 50_000n,
                currency: 'RUB',
                appliedAt: expect.any(Date),
            },
        ])
        // It came from no webhook.
        expect(await t.metric('payment_webhooks_total')).toBe(webhooksBefore)

        // No longer pending: nobody asks again.
        provider.asked = []
        await round()
        expect(provider.asked).toEqual([])
        expect(await eventsOf(payment.id)).toHaveLength(1)
    })

    it('fails on a failed record', async () => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, {
            providerPaymentId: payment.providerPaymentId,
            outcome: 'failed',
        })
        const before = await results()
        await round()
        expect(await stored(payment.id)).toMatchObject({
            status: 'failed',
            failureReason: 'provider',
        })
        expect(await since(before)).toEqual({
            applied: 1,
        })
        expect(await eventsOf(payment.id)).toEqual([])
    })

    it('takes the id of the payment it asked about, not the one the record names', async () => {
        const other = await pending({
            createdAt: new Date(),
        })
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(other.providerPaymentId))
        await round()
        expect((await stored(other.id)).status).toBe('pending')
        expect((await stored(payment.id)).status).toBe('succeeded')
    })

    it.each([
        [
            'another amount',
            49_999n,
            'RUB',
        ],
        [
            'another currency',
            50_000n,
            'USD',
        ],
    ] as const)('does not pay for %s, records it once and keeps counting it', async (_case, amountMinor, currency) => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId, amountMinor, currency))
        const error = vi.spyOn(Logger.prototype, 'error')
        const before = await results()

        await round()
        expect((await stored(payment.id)).status).toBe('pending')
        expect(await since(before)).toEqual({
            mismatch: 1,
        })
        expect(await eventsOf(payment.id)).toEqual([])
        expect(await factsOf(payment.id)).toMatchObject([
            {
                outcome: 'mismatch',
                appliedAt: null,
            },
        ])
        expect(error).toHaveBeenCalledTimes(1)

        // Still the same answer: counted, not recorded or logged again, and a later right record does not pay.
        await round()
        expect(await since(before)).toEqual({
            mismatch: 2,
        })
        expect(await factsOf(payment.id)).toHaveLength(1)
        expect(error).toHaveBeenCalledTimes(1)

        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        await round()
        expect((await stored(payment.id)).status).toBe('pending')
        expect(await eventsOf(payment.id)).toEqual([])
    })

    it.each([
        [
            'the amount',
            {
                currency: 'RUB' as const,
            },
        ],
        [
            'the currency',
            {
                amountMinor: 50_000n,
            },
        ],
    ])(
        'takes a paid record that leaves out %s for not settled yet, and pays when it shows the money',
        async (_case, money) => {
            const payment = await pending()
            provider.records.set(payment.providerPaymentId, {
                providerPaymentId: payment.providerPaymentId,
                outcome: 'succeeded',
                ...money,
            })
            const before = await results()
            await round()
            expect((await stored(payment.id)).status).toBe('pending')
            expect(await since(before)).toEqual({
                open: 1,
            })
            expect(await t.db.select().from(webhookEvents)).toEqual([])

            provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
            await round()
            expect((await stored(payment.id)).status).toBe('succeeded')
        },
    )

    it('changes nothing on open and on no record', async () => {
        const open = await pending()
        provider.records.set(open.providerPaymentId, 'open')
        const missing = await pending()
        const before = await results()

        await round()

        expect(await since(before)).toEqual({
            open: 1,
            missing: 1,
        })
        for (const payment of [
            open,
            missing,
        ]) {
            const { providerCheckedAt: _asked, ...now } = await stored(payment.id)
            const { providerCheckedAt: _never, ...then } = payment
            expect(now).toEqual(then)
        }
        expect(await t.db.select().from(webhookEvents)).toEqual([])
        expect(await t.db.select().from(outbox)).toEqual([])
    })

    it('changes nothing and counts an error when the provider cannot be asked, and goes on with the others', async () => {
        const broken = await pending()
        provider.records.set(broken.providerPaymentId, new Error('provider answered 503'))
        const fine = await pending()
        provider.records.set(fine.providerPaymentId, paid(fine.providerPaymentId))
        const warn = vi.spyOn(Logger.prototype, 'warn')
        const before = await results()

        await round()

        expect(await since(before)).toEqual({
            applied: 1,
            error: 1,
        })
        expect((await stored(broken.id)).status).toBe('pending')
        expect((await stored(fine.id)).status).toBe('succeeded')
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                providerPaymentId: broken.providerPaymentId,
            }),
            expect.any(String),
        )

        provider.records.set(broken.providerPaymentId, paid(broken.providerPaymentId))
        await round()
        expect((await stored(broken.id)).status).toBe('succeeded')
    })

    it('asks only about pending payments of this provider, with a provider id, from 10 minutes to 7 days old', async () => {
        const watched = await pending()
        const others = await Promise.all([
            pending({
                createdAt: sql`now() - interval '9 minutes'`,
            }),
            pending({
                createdAt: sql`now() - interval '8 days'`,
            }),
            pending({
                providerPaymentId: null,
            }),
            pending({
                status: 'creating',
            }),
            pending({
                status: 'failed',
            }),
            pending({
                status: 'succeeded',
                paidAt: new Date(),
            }),
            pending({
                // A payment of the provider this service ran before.
                provider: 'previous',
            }),
        ])
        await round()
        expect(provider.asked).toEqual([
            watched.providerPaymentId,
        ])
        for (const other of others) expect((await stored(other.id)).status).toBe(other.status)
    })

    it('counts in the gauge what it watches', async () => {
        await pending()
        const confirmed = await pending()
        provider.records.set(confirmed.providerPaymentId, paid(confirmed.providerPaymentId))
        await pending({
            createdAt: sql`now() - interval '9 minutes'`,
        })
        await pending({
            createdAt: sql`now() - interval '8 days'`,
        })
        await pending({
            providerPaymentId: null,
        })
        await pending({
            provider: 'previous',
        })
        expect(await t.metric('payments_unconfirmed')).toBe(2)
        await round()
        expect(await t.metric('payments_unconfirmed')).toBe(1)
    })
})

describe('the sync and a webhook', () => {
    it('pays once when the webhook comes after the sync', async () => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        await round()
        const response = await webhook(payment.providerPaymentId, 'late-webhook').expect(200)
        expect(response.body.status).toBe('duplicate')
        expect(await eventsOf(payment.id)).toHaveLength(1)
    })

    it('does not ask when the webhook came first', async () => {
        const payment = await pending()
        expect((await webhook(payment.providerPaymentId, 'first-webhook').expect(200)).body.status).toBe('applied')
        await round()
        expect(provider.asked).toEqual([])
        expect(await eventsOf(payment.id)).toHaveLength(1)
    })

    it('pays once, and counts nothing, when the webhook lands during the lookup', async () => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        provider.during = async () => {
            await webhook(payment.providerPaymentId, 'webhook-during-lookup').expect(200)
        }
        const before = await results()
        await round()
        expect(await since(before)).toEqual({})
        expect((await stored(payment.id)).status).toBe('succeeded')
        expect(await eventsOf(payment.id)).toHaveLength(1)
    })

    it('records one fact when two pods ask at once', async () => {
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        const service = t.app.get(PaymentsService)
        const answers = await Promise.all([
            service.askProvider(payment),
            service.askProvider(payment),
        ])
        expect(answers.filter(answer => answer === 'applied')).toHaveLength(1)
        expect(await factsOf(payment.id)).toHaveLength(1)
        expect(await eventsOf(payment.id)).toHaveLength(1)
    })
})

describe('a round', () => {
    it('asks about a limited batch, the ones asked longest ago first, so open payments keep no one waiting', async () => {
        const rows = await t.db
            .insert(payments)
            .values(
                Array.from(
                    {
                        length: 70,
                    },
                    () => row(),
                ),
            )
            .returning()
        const ids = rows.map(payment => payment.providerPaymentId)
        for (const id of ids) if (id) provider.records.set(id, 'open')

        await round()
        expect(provider.asked).toHaveLength(50)
        const first = new Set(provider.asked)

        provider.asked = []
        await round()
        expect(provider.asked).toHaveLength(50)
        expect(new Set(provider.asked).size).toBe(50)
        // The 20 not asked yet come first, then the oldest answers.
        expect(provider.asked.slice(0, 20).every(id => !first.has(id))).toBe(true)
        expect(new Set(ids)).toEqual(
            new Set([
                ...first,
                ...provider.asked,
            ]),
        )

        // A new payment does not wait for the old ones.
        const fresh = await pending()
        provider.records.set(fresh.providerPaymentId, 'open')
        provider.asked = []
        await round()
        expect(provider.asked[0]).toBe(fresh.providerPaymentId)
    })

    it('leaves the batch to the pod that holds the lock', async () => {
        await pending()
        const release = Promise.withResolvers<void>()
        const locked = Promise.withResolvers<void>()
        const holder = t.db.transaction(async tx => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pay-api:provider-sync', 0))`)
            locked.resolve()
            await release.promise
        })
        await locked.promise
        await round()
        expect(provider.asked).toEqual([])
        release.resolve()
        await holder

        await round()
        expect(provider.asked).toHaveLength(1)
    })

    it('asks outside any transaction: a slow provider holds no lock and no session open', async () => {
        const payment = await pending()
        const seen: {
            locked?: boolean
            idle?: number
        } = {}
        provider.during = async () => {
            const lock = await t.db.transaction(tx =>
                tx.execute<{
                    locked: boolean
                }>(sql`select pg_try_advisory_xact_lock(hashtextextended('pay-api:provider-sync', 0)) as locked`),
            )
            seen.locked = lock.rows[0]?.locked
            const idle = await t.db.execute<{
                total: number
            }>(
                sql`select count(*)::int as total from pg_stat_activity where application_name = 'pay-api' and state like 'idle in transaction%'`,
            )
            seen.idle = idle.rows[0]?.total
        }
        await round()
        expect(provider.asked).toEqual([
            payment.providerPaymentId,
        ])
        expect(seen).toEqual({
            locked: true,
            idle: 0,
        })
    })

    it('runs the sync even when the ledger cannot be asked', async () => {
        await pending({
            status: 'succeeded',
            paidAt: sql`now() - interval '6 minutes'`,
        })
        const payment = await pending()
        provider.records.set(payment.providerPaymentId, paid(payment.providerPaymentId))
        const ledger = await t.metric('payment_reconciliation_total', {
            result: 'error',
        })
        await round()
        expect(
            await t.metric('payment_reconciliation_total', {
                result: 'error',
            }),
        ).toBe(ledger + 1)
        expect((await stored(payment.id)).status).toBe('succeeded')
    })

    it('stops between lookups on shutdown, so a slow provider cannot outlast the deadline', async () => {
        const own = new ScriptedProvider()
        const app = await startApp(identity, {}, own)
        try {
            await pending()
            await pending()
            await pending()
            const service = app.app.get(ReconciliationService)
            own.during = async () => {
                void service.beforeApplicationShutdown()
            }
            await service.round()
            expect(own.asked).toHaveLength(1)
        } finally {
            await app.close()
        }
    })
})
