import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import type { PaymentRow } from '../src/db/types.js'
import { CheckoutRefused, type PaymentProvider } from '../src/providers/provider.js'

/** What the test can make the provider do. */
export type ProviderSide = {
    /** How the provider answers from now on: `ok`, a refused create, an outage, or garbage. */
    answers(how: 'ok' | 'refused' | 'unavailable' | 'malformed'): void
    /** The next create call makes the checkout, and its answer is lost. */
    losesNextAnswer(): void
    /** How many checkouts the provider holds for this payment. */
    checkoutsOf(payment: PaymentRow): number
    /** The provider's record of a checkout settles. */
    settles(
        providerPaymentId: string,
        record:
            | {
                  outcome: 'succeeded'
                  amount: number
                  currency: string
              }
            | {
                  outcome: 'failed'
              },
    ): void
}

/** What a real webhook of the provider looks like. */
export type ProviderWebhooks = {
    /** The headers with the right credential. */
    credential: Record<string, string>
    /** Headers with a credential that must be refused. */
    wrongCredentials: Record<string, string | string[] | undefined>[]
    paid(
        providerPaymentId: string,
        money: {
            amount: unknown
            currency: unknown
        },
    ): unknown
    failed(providerPaymentId: string): unknown
}

export type ContractSubject = {
    provider: PaymentProvider
    /** null for an adapter that has no provider behind it: it never refuses, fails or settles. */
    side: ProviderSide | null
    /** null for an adapter without webhooks. */
    webhooks: ProviderWebhooks | null
    close(): Promise<void>
}

/**
 * What the service relies on from any adapter: one suite, run for every
 * adapter from a factory, with what only some of them can do skipped by `side`
 * and `webhooks`. A new adapter passes it against a stand-in of its provider.
 */
export function providerContract(name: string, start: () => Promise<ContractSubject>) {
    describe(`the ${name} adapter honours the provider contract`, () => {
        let subject: ContractSubject
        let provider: PaymentProvider

        /** What this test needs from the adapter, or the test is skipped. */
        const needs = <T>(ability: T | null, context: TestContext): T => {
            if (ability === null) context.skip()
            return ability
        }

        const aPayment = (): PaymentRow => ({
            id: randomUUID(),
            userId: randomUUID(),
            productKey: 'coins-550',
            coins: 550,
            amount: '500',
            currency: 'RUB',
            provider: name,
            providerPaymentId: null,
            checkoutUrl: null,
            status: 'creating',
            idempotencyKey: randomUUID(),
            fingerprint: 'x',
            failureReason: null,
            checkoutLeaseToken: null,
            checkoutLeaseUntil: null,
            paidAt: null,
            reconciledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })

        const create = (payment = aPayment()) =>
            provider.createCheckout({
                payment,
                email: 'buyer@example.com',
                locale: 'en',
            })

        /** The error `promise` rejects with; fails the test when it resolves. */
        const rejection = (promise: Promise<unknown>) =>
            promise.then(
                value => {
                    throw new Error(`expected a rejection, got ${JSON.stringify(value)}`)
                },
                (error: unknown) => error,
            )

        beforeAll(async () => {
            subject = await start()
            provider = subject.provider
        })
        afterAll(() => subject?.close())
        afterEach(() => subject?.side?.answers('ok'))

        it('goes by the name of the registry', () => {
            expect(provider.name).toBe(name)
        })

        describe('createCheckout', () => {
            it('returns an id and a URL', async () => {
                const { providerPaymentId, checkoutUrl } = await create()
                expect(providerPaymentId).toEqual(expect.any(String))
                expect(providerPaymentId).not.toBe('')
                expect(new URL(checkoutUrl).protocol).toMatch(/^https?:$/)
            })

            it('throws CheckoutRefused only when nothing was created', async context => {
                const side = needs(subject.side, context)
                const payment = aPayment()
                side.answers('refused')
                expect(await rejection(create(payment))).toBeInstanceOf(CheckoutRefused)
                side.answers('ok')
                expect(side.checkoutsOf(payment)).toBe(0)
                expect(await provider.findCheckout(payment)).toBeNull()
            })

            it('throws anything else when the answer is lost after the checkout was made', async context => {
                const side = needs(subject.side, context)
                const payment = aPayment()
                side.losesNextAnswer()
                expect(await rejection(create(payment))).not.toBeInstanceOf(CheckoutRefused)
                expect(side.checkoutsOf(payment)).toBe(1)
            })

            it.for([
                'unavailable',
                'malformed',
            ] as const)('does not call an answer that is %s a refusal', async (how, context) => {
                const side = needs(subject.side, context)
                side.answers(how)
                expect(await rejection(create())).not.toBeInstanceOf(CheckoutRefused)
            })
        })

        describe('findCheckout', () => {
            it('gives null when the provider has none', async () => {
                expect(await provider.findCheckout(aPayment())).toBeNull()
            })

            it('gives the checkout it made for the payment, and only for that one', async () => {
                const payment = aPayment()
                const { providerPaymentId } = await create(payment)
                expect(await provider.findCheckout(payment)).toMatchObject({
                    providerPaymentId,
                })
                expect(await provider.findCheckout(aPayment())).toBeNull()
            })

            it('finds the checkout whose answer was lost', async context => {
                const side = needs(subject.side, context)
                const payment = aPayment()
                side.losesNextAnswer()
                await rejection(create(payment))
                expect(await provider.findCheckout(payment)).toMatchObject({
                    providerPaymentId: expect.any(String),
                })
            })

            it.for([
                'unavailable',
                'malformed',
            ] as const)('throws when it cannot tell: %s', async (how, context) => {
                const side = needs(subject.side, context)
                side.answers(how)
                await rejection(provider.findCheckout(aPayment()))
            })
        })

        describe('lookup', () => {
            it('gives undefined for an id the provider does not have', async () => {
                expect(await provider.lookup('no-such-id')).toBeUndefined()
            })

            it('gives open for a checkout neither paid nor failed', async () => {
                const { providerPaymentId } = await create()
                expect(await provider.lookup(providerPaymentId)).toBe('open')
            })

            it('gives a fact with exact minor units for a paid one', async context => {
                const side = needs(subject.side, context)
                const { providerPaymentId } = await create()
                side.settles(providerPaymentId, {
                    outcome: 'succeeded',
                    amount: 500.5,
                    currency: 'RUB',
                })
                expect(await provider.lookup(providerPaymentId)).toEqual({
                    providerPaymentId,
                    outcome: 'succeeded',
                    amountMinor: 50_050n,
                    currency: 'RUB',
                })
            })

            it('leaves out what it cannot read exactly, never rounding it', async context => {
                const side = needs(subject.side, context)
                const { providerPaymentId } = await create()
                side.settles(providerPaymentId, {
                    outcome: 'succeeded',
                    amount: 499.999,
                    currency: 'RUB',
                })
                expect(await provider.lookup(providerPaymentId)).toMatchObject({
                    providerPaymentId,
                    outcome: 'succeeded',
                    amountMinor: undefined,
                })
            })

            it('gives a fact for a failed one', async context => {
                const side = needs(subject.side, context)
                const { providerPaymentId } = await create()
                side.settles(providerPaymentId, {
                    outcome: 'failed',
                })
                expect(await provider.lookup(providerPaymentId)).toMatchObject({
                    providerPaymentId,
                    outcome: 'failed',
                })
            })

            it.for([
                'unavailable',
                'malformed',
            ] as const)('throws when the provider cannot be asked: %s', async (how, context) => {
                const side = needs(subject.side, context)
                const { providerPaymentId } = await create()
                side.answers(how)
                await rejection(provider.lookup(providerPaymentId))
            })
        })

        describe('authenticate', () => {
            it('refuses a missing credential', () => {
                expect(provider.authenticate({})).toBe(false)
            })

            it('refuses a wrong credential', () => {
                for (const headers of [
                    {
                        'x-api-key': 'wrong',
                        authorization: 'Bearer wrong',
                        'x-signature': 'wrong',
                    },
                    {
                        'x-api-key': [
                            'wrong',
                            'wrong',
                        ],
                    },
                    ...(subject.webhooks?.wrongCredentials ?? []),
                ])
                    expect(provider.authenticate(headers)).toBe(false)
            })

            it('takes the right one', context => {
                const webhooks = needs(subject.webhooks, context)
                expect(provider.authenticate(webhooks.credential)).toBe(true)
            })
        })

        describe('parse', () => {
            const rejected = {
                rejected: expect.any(String),
            }

            it.for([
                null,
                undefined,
                'text',
                42,
                true,
                [],
                {},
                {
                    hello: 'world',
                },
                {
                    eventType: 'something.else',
                    contractId: 'x',
                },
            ])('gives rejected for %j, and does not throw', payload => {
                expect(provider.parse(payload)).toEqual(rejected)
            })

            it.for([
                [
                    500,
                    50_000n,
                ],
                [
                    '500',
                    50_000n,
                ],
                [
                    500.5,
                    50_050n,
                ],
                [
                    '0.01',
                    1n,
                ],
            ] as const)('gives a fact with exact minor units for the amount %j', ([amount, amountMinor], context) => {
                const webhooks = needs(subject.webhooks, context)
                expect(
                    provider.parse(
                        webhooks.paid('id-1', {
                            amount,
                            currency: 'RUB',
                        }),
                    ),
                ).toMatchObject({
                    fact: {
                        providerPaymentId: 'id-1',
                        outcome: 'succeeded',
                        amountMinor,
                        currency: 'RUB',
                    },
                })
            })

            it.for([
                499.999,
                '500.001',
                '5e2',
                '-500',
                '500 ',
                '',
                {},
                [],
                true,
            ])('gives rejected for the amount %j, not a rounded one', (amount, context) => {
                const webhooks = needs(subject.webhooks, context)
                expect(
                    provider.parse(
                        webhooks.paid('id-1', {
                            amount,
                            currency: 'RUB',
                        }),
                    ),
                ).toEqual(rejected)
            })

            it('gives rejected for a currency we do not sell', context => {
                const webhooks = needs(subject.webhooks, context)
                expect(
                    provider.parse(
                        webhooks.paid('id-1', {
                            amount: 500,
                            currency: 'XXX',
                        }),
                    ),
                ).toEqual(rejected)
            })

            it('gives a failure as a fact', context => {
                const webhooks = needs(subject.webhooks, context)
                expect(provider.parse(webhooks.failed('id-1'))).toMatchObject({
                    fact: {
                        providerPaymentId: 'id-1',
                        outcome: 'failed',
                    },
                })
            })

            it('gives a dedupe key that is stable per event and differs between events', context => {
                const webhooks = needs(subject.webhooks, context)
                const money = {
                    amount: 500,
                    currency: 'RUB',
                }
                const key = (payload: unknown) => {
                    const parsed = provider.parse(payload)
                    if (!('fact' in parsed)) throw new Error(`rejected: ${parsed.rejected}`)
                    return parsed.fact.dedupeKey
                }
                const paid = key(webhooks.paid('id-1', money))
                expect(paid).not.toBe('')
                expect(key(webhooks.paid('id-1', money))).toBe(paid)
                expect(key(webhooks.paid('id-2', money))).not.toBe(paid)
                expect(key(webhooks.failed('id-1'))).not.toBe(paid)
            })
        })
    })
}
