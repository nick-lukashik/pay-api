import type { Currency } from '@nick-lukashik/contracts'

export type Product = {
    key: string
    coins: number
    title: {
        en: string
        ru: string
    }
    /** Decimal strings per currency. */
    prices: Record<Currency, string>
}

/**
 * Coin packs for sale: $1 is 100 coins, bigger packs add a bonus. Prices
 * in rubles and euros are round numbers next to the dollar ones. A change
 * here is a new price for new checkouts; past payments keep their snapshot.
 */
export const catalog: readonly Product[] = [
    {
        key: 'coins-100',
        coins: 100,
        title: {
            en: '100 coins',
            ru: '100 монет',
        },
        prices: {
            RUB: '100',
            USD: '1',
            EUR: '1',
        },
    },
    {
        key: 'coins-550',
        coins: 550,
        title: {
            en: '550 coins (+10%)',
            ru: '550 монет (+10%)',
        },
        prices: {
            RUB: '500',
            USD: '5',
            EUR: '5',
        },
    },
    {
        key: 'coins-1200',
        coins: 1200,
        title: {
            en: '1200 coins (+20%)',
            ru: '1200 монет (+20%)',
        },
        prices: {
            RUB: '1000',
            USD: '10',
            EUR: '10',
        },
    },
]

export const productByKey = (key: string) => catalog.find(product => product.key === key)
