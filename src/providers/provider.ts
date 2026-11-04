import type { PaymentRow } from '../db/types.js'

export type CheckoutInput = {
    payment: PaymentRow
    email: string
    locale: 'en' | 'ru'
}

/** A provider fact about a payment, after its credential was checked. */
export type ProviderFact = {
    providerPaymentId: string
    outcome: 'succeeded' | 'failed'
    /** As the provider reports them; compared with the order snapshot when present. */
    amount?: string
    currency?: string
    /** Unique per fact: a repeated webhook is recorded once. */
    dedupeKey: string
}

/**
 * The provider contract: create a checkout and turn an authenticated webhook
 * into a fact. Nothing outside the adapter knows the provider's format.
 */
export abstract class PaymentProvider {
    abstract readonly name: string
    abstract createCheckout(input: CheckoutInput): Promise<{
        providerPaymentId: string
        checkoutUrl: string
    }>
    /** Credential of an incoming webhook, checked before the payload is trusted. */
    abstract authenticate(headers: Record<string, string | string[] | undefined>): boolean
    /** undefined: authenticated but not about a payment we track (ignored). */
    abstract parse(payload: unknown): ProviderFact | undefined
}
