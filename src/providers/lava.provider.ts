import { secretMatches } from '@nick-lukashik/auth'
import { type Currency, currencySchema } from '@nick-lukashik/contracts'
import { z } from 'zod'
import type { PaymentRow } from '../db/types.js'
import { toMinorUnits } from './money.js'
import { type CheckoutInput, CheckoutRefused, type ParsedWebhook, PaymentProvider } from './provider.js'

const TIMEOUT_MS = 10_000
/** How far the search for a lost invoice goes: pages of the key's invoices since the payment was created. */
const FIND_PAGES = 10
const FIND_PAGE_SIZE = 50

/** The variables of this adapter, read only when `PAY_PROVIDER=lava`. */
export const lavaEnv = z.object({
    LAVA_API_URL: z.url().default('https://gate.lava.top'),
    LAVA_API_KEY: z.string().min(1),
    /** The X-Api-Key Lava sends with webhooks; separate from the API key. */
    LAVA_WEBHOOK_SECRET: z.string().min(32),
    /** The offer of each product, see `offerOf`. */
    LAVA_OFFER_COINS_100: z.uuid().optional(),
    LAVA_OFFER_COINS_550: z.uuid().optional(),
    LAVA_OFFER_COINS_1200: z.uuid().optional(),
})
type LavaEnv = z.output<typeof lavaEnv>

/** Lava sells offers of the merchant account: the offer of each product of the catalog. */
const offerOf = (env: LavaEnv, productKey: string) =>
    ({
        'coins-100': env.LAVA_OFFER_COINS_100,
        'coins-550': env.LAVA_OFFER_COINS_550,
        'coins-1200': env.LAVA_OFFER_COINS_1200,
    })[productKey]

const invoiceSchema = z.object({
    id: z.string().min(1).max(100),
    paymentUrl: z.url(),
})

/** A contract (InvoiceResponseV3) of GET /api/v2/invoices and /api/v2/invoices/{id}, only what we read. */
const contractSchema = z.object({
    id: z.string().min(1).max(100),
    status: z.string(),
    receipt: z
        .object({
            amount: z.number().nullish(),
            currency: z.string().nullish(),
        })
        .nullish(),
    clientUtm: z
        .object({
            utm_content: z.string().nullish(),
        })
        .nullish(),
})

const contractPageSchema = z.object({
    items: z.array(contractSchema),
    total: z.number().int(),
})

const webhookSchema = z.object({
    eventType: z.enum([
        'payment.success',
        'payment.failed',
    ]),
    contractId: z.string().min(1).max(100),
    status: z.string().max(64).optional(),
    amount: z
        .union([
            z.number(),
            z.string().max(32),
        ])
        .nullish(),
    currency: z.string().max(8).nullish(),
})

/**
 * lava.top, ported from the previous platform (ADR-005 there): one-time
 * invoices for an offer of the merchant account (`POST /api/v3/invoice`,
 * header X-Api-Key), webhooks authenticated by the X-Api-Key Lava sends.
 * Not yet checked against the merchant account: offers, sandbox and status
 * values are assumptions from Lava's OpenAPI 1.22.0.
 *
 * Lava takes no idempotency key and no order id of ours. The payment id rides
 * in `clientUtm.utm_content`, which Lava keeps on the contract: a lost answer
 * is found again by it in the key's list of contracts.
 */
export class LavaProvider extends PaymentProvider {
    readonly name = 'lava'

    constructor(private readonly env: LavaEnv) {
        super()
    }

    async createCheckout({ payment, email, locale }: CheckoutInput) {
        const offerId = offerOf(this.env, payment.productKey)
        if (!offerId) throw new CheckoutRefused(`no Lava offer configured for ${payment.productKey}`)
        // Thrown before an answer (timeout, connection lost): Lava may have created it.
        const response = await fetch(`${this.env.LAVA_API_URL}/api/v3/invoice`, {
            method: 'POST',
            headers: {
                'x-api-key': this.env.LAVA_API_KEY,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email,
                offerId,
                currency: payment.currency,
                buyerLanguage: locale === 'ru' ? 'RU' : 'EN',
                clientUtm: {
                    utm_content: payment.id,
                },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        // A 4xx is a refusal; after a 5xx the invoice may still exist.
        if (response.status >= 400 && response.status < 500)
            throw new CheckoutRefused(`Lava answered ${response.status}`)
        if (!response.ok) throw new Error(`Lava answered ${response.status}`)
        const invoice = invoiceSchema.parse(await response.json())
        if (new URL(invoice.paymentUrl).protocol !== 'https:') throw new Error('Lava payment URL is not https')
        return {
            providerPaymentId: invoice.id,
            checkoutUrl: invoice.paymentUrl,
        }
    }

    /** By our payment id in clientUtm. The list has no payment URL, so it is left out. */
    async findCheckout(payment: PaymentRow) {
        const signal = AbortSignal.timeout(TIMEOUT_MS)
        for (let page = 1; page <= FIND_PAGES; page++) {
            const url = new URL(`${this.env.LAVA_API_URL}/api/v2/invoices`)
            // A minute of slack for the clocks of Lava and ours.
            url.searchParams.set('beginDate', new Date(payment.createdAt.getTime() - 60_000).toISOString())
            url.searchParams.set('currencies', payment.currency)
            for (const status of [
                'NEW',
                'IN_PROGRESS',
                'COMPLETED',
                'FAILED',
            ])
                url.searchParams.append('invoiceStatuses', status)
            url.searchParams.set('page', String(page))
            url.searchParams.set('size', String(FIND_PAGE_SIZE))
            const response = await fetch(url, {
                headers: {
                    'x-api-key': this.env.LAVA_API_KEY,
                },
                signal,
            })
            if (!response.ok) throw new Error(`Lava answered ${response.status}`)
            const { items, total } = contractPageSchema.parse(await response.json())
            const mine = items.find(item => item.clientUtm?.utm_content === payment.id)
            if (mine)
                return {
                    providerPaymentId: mine.id,
                }
            if (items.length === 0 || page * FIND_PAGE_SIZE >= total) return null
        }
        throw new Error('too many Lava contracts to search for a lost checkout')
    }

    async lookup(providerPaymentId: string) {
        const response = await fetch(
            `${this.env.LAVA_API_URL}/api/v2/invoices/${encodeURIComponent(providerPaymentId)}`,
            {
                headers: {
                    'x-api-key': this.env.LAVA_API_KEY,
                },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            },
        )
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`Lava answered ${response.status}`)
        const contract = contractSchema.parse(await response.json())
        if (contract.status === 'FAILED')
            return {
                providerPaymentId,
                outcome: 'failed' as const,
            }
        if (contract.status !== 'COMPLETED') return 'open' as const
        const currency = currencySchema.safeParse(contract.receipt?.currency)
        const amount = contract.receipt?.amount ?? undefined
        return {
            providerPaymentId,
            outcome: 'succeeded' as const,
            currency: currency.data,
            amountMinor: currency.success && amount !== undefined ? toMinorUnits(amount, currency.data) : undefined,
        }
    }

    authenticate(headers: Record<string, string | string[] | undefined>) {
        const presented = headers['x-api-key']
        return secretMatches(typeof presented === 'string' ? presented : undefined, this.env.LAVA_WEBHOOK_SECRET)
    }

    parse(payload: unknown): ParsedWebhook {
        const parsed = webhookSchema.safeParse(payload)
        if (!parsed.success)
            return {
                rejected: 'not a payment event',
            }
        const event = parsed.data
        let currency: Currency | undefined
        if (event.currency !== undefined && event.currency !== null) {
            const known = currencySchema.safeParse(event.currency)
            if (!known.success)
                return {
                    rejected: 'currency we do not sell',
                }
            currency = known.data
        }
        // Without the currency the amount has no unit: a success is then confirmed through lookup.
        const amount = event.amount ?? undefined
        const amountMinor = currency && amount !== undefined ? toMinorUnits(amount, currency) : undefined
        if (currency && amount !== undefined && amountMinor === undefined)
            return {
                rejected: 'malformed amount',
            }
        return {
            fact: {
                providerPaymentId: event.contractId,
                outcome: event.eventType === 'payment.success' ? 'succeeded' : 'failed',
                amountMinor,
                currency,
                dedupeKey: `${event.eventType}:${event.contractId}:${event.status ?? ''}`,
            },
        }
    }
}
