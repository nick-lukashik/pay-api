import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { secretMatches } from '@nick-lukashik/auth'
import { z } from 'zod'
import { productByKey } from '../catalog/catalog.js'
import { payConfig } from '../config/config.js'
import { type CheckoutInput, PaymentProvider, type ProviderFact } from './provider.js'

const invoiceSchema = z.object({
    id: z.string().min(1).max(100),
    paymentUrl: z.url(),
})

const webhookSchema = z.object({
    eventType: z.enum([
        'payment.success',
        'payment.failed',
    ]),
    contractId: z.string().min(1).max(100),
    status: z.string().max(64).optional(),
    amount: z.union([
        z.number(),
        z.string(),
    ]),
    currency: z.string().max(8).optional(),
})

/**
 * lava.top, ported from the previous platform (ADR-005 there): one-time
 * invoices for an offer of the merchant account (`POST /api/v3/invoice`,
 * header X-Api-Key), webhooks authenticated by the X-Api-Key Lava sends.
 * Not yet checked against the merchant account: offers, sandbox and status
 * values are assumptions from Lava's OpenAPI 1.22.0.
 */
@Injectable()
export class LavaProvider extends PaymentProvider {
    readonly name = 'lava'

    constructor(@Inject(payConfig.KEY) private readonly config: ConfigType<typeof payConfig>) {
        super()
    }

    async createCheckout({ payment, email, locale }: CheckoutInput) {
        const product = productByKey(payment.productKey)
        const offerId = product ? this.config.lava.offers[product.lavaOfferEnv] : undefined
        if (!offerId) throw new Error(`no Lava offer configured for ${payment.productKey}`)
        const response = await fetch(`${this.config.lava.apiUrl}/api/v3/invoice`, {
            method: 'POST',
            headers: {
                'x-api-key': this.config.lava.apiKey,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email,
                offerId,
                currency: payment.currency,
                buyerLanguage: locale === 'ru' ? 'RU' : 'EN',
            }),
            signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`Lava answered ${response.status}`)
        const invoice = invoiceSchema.parse(await response.json())
        if (new URL(invoice.paymentUrl).protocol !== 'https:') throw new Error('Lava payment URL is not https')
        return {
            providerPaymentId: invoice.id,
            checkoutUrl: invoice.paymentUrl,
        }
    }

    authenticate(headers: Record<string, string | string[] | undefined>) {
        const presented = headers['x-api-key']
        return secretMatches(typeof presented === 'string' ? presented : undefined, this.config.lava.webhookSecret)
    }

    parse(payload: unknown): ProviderFact | undefined {
        const parsed = webhookSchema.safeParse(payload)
        if (!parsed.success) return undefined
        const event = parsed.data
        return {
            providerPaymentId: event.contractId,
            outcome: event.eventType === 'payment.success' ? 'succeeded' : 'failed',
            amount: String(event.amount),
            currency: event.currency,
            dedupeKey: `${event.eventType}:${event.contractId}:${event.status ?? ''}`,
        }
    }
}
