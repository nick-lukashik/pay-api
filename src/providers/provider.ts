import type { Currency } from '@nick-lukashik/contracts'
import type { PaymentRow } from '../db/types.js'

export type CheckoutInput = {
    payment: PaymentRow
    email: string
    locale: 'en' | 'ru'
}

export type Checkout = {
    providerPaymentId: string
    checkoutUrl: string
}

/** A checkout found again after a lost answer; without the URL when the provider does not give it again. */
export type FoundCheckout = {
    providerPaymentId: string
    checkoutUrl?: string
}

/**
 * The provider answered that it created nothing: the checkout may be tried
 * again. Any other error of `createCheckout` leaves the outcome unknown.
 */
export class CheckoutRefused extends Error {
    override readonly name = 'CheckoutRefused'
}

/** A provider fact about a payment, after its credential was checked. */
export type ProviderFact = {
    providerPaymentId: string
    outcome: 'succeeded' | 'failed'
    /** Minor units (kopecks, cents), parsed exactly; undefined when the provider left it out. */
    amountMinor?: bigint
    /** undefined when the provider left it out. */
    currency?: Currency
    /** Unique per fact: a repeated webhook is recorded once. */
    dedupeKey: string
}

/** An authenticated webhook: a fact, or the reason it cannot be trusted or understood. */
export type ParsedWebhook =
    | {
          fact: ProviderFact
      }
    | {
          rejected: string
      }

/** The provider's own record of a payment: 'open' while neither paid nor failed, undefined when it has none. */
export type ProviderRecord = Omit<ProviderFact, 'dedupeKey'> | 'open' | undefined

/**
 * The provider contract: create a checkout, find one whose answer was lost,
 * read the provider's record of a payment and turn an authenticated webhook
 * into a fact. Nothing outside the adapter knows the provider's format.
 */
export abstract class PaymentProvider {
    abstract readonly name: string
    /** Throws CheckoutRefused when nothing was created; any other error: it may have been. */
    abstract createCheckout(input: CheckoutInput): Promise<Checkout>
    /**
     * The checkout an earlier createCheckout with an unknown outcome may have
     * made for this payment: null when the provider has none, throws when it
     * cannot tell.
     */
    abstract findCheckout(payment: PaymentRow): Promise<FoundCheckout | null>
    /**
     * Asked when a webhook leaves out what a success needs, and by the periodic
     * job about a payment whose webhook never came; throws when the provider
     * cannot be asked.
     */
    abstract lookup(providerPaymentId: string): Promise<ProviderRecord>
    /** Credential of an incoming webhook, checked before the payload is trusted. */
    abstract authenticate(headers: Record<string, string | string[] | undefined>): boolean
    abstract parse(payload: unknown): ParsedWebhook
}
