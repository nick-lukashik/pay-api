import type { Currency } from '@nick-lukashik/contracts'

export type Product = {
    key: string
    grm: number
    title: {
        en: string
        ru: string
    }
    /** Decimal strings per currency. */
    prices: Record<Currency, string>
    /** The provider's offer per product (Lava: an offer of the merchant account), from env. */
    lavaOfferEnv: string
}

/**
 * GRM packs for sale. Prices are a starting point chosen without the owner;
 * a change here is a new price for new checkouts, past payments keep their
 * snapshot.
 */
export const catalog: readonly Product[] = [
    {
        key: 'grm-100',
        grm: 100,
        title: {
            en: '100 GRM',
            ru: '100 GRM',
        },
        prices: {
            RUB: '99',
            USD: '1.19',
            EUR: '1.09',
        },
        lavaOfferEnv: 'LAVA_OFFER_GRM_100',
    },
    {
        key: 'grm-550',
        grm: 550,
        title: {
            en: '550 GRM (+10%)',
            ru: '550 GRM (+10%)',
        },
        prices: {
            RUB: '499',
            USD: '5.99',
            EUR: '5.49',
        },
        lavaOfferEnv: 'LAVA_OFFER_GRM_550',
    },
    {
        key: 'grm-1200',
        grm: 1200,
        title: {
            en: '1200 GRM (+20%)',
            ru: '1200 GRM (+20%)',
        },
        prices: {
            RUB: '999',
            USD: '11.99',
            EUR: '10.99',
        },
        lavaOfferEnv: 'LAVA_OFFER_GRM_1200',
    },
]

export const productByKey = (key: string) => catalog.find(product => product.key === key)
