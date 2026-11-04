import type { Currency } from '@nick-lukashik/contracts'

/** Digits after the point (the ISO 4217 minor unit) of each currency we sell. */
const MINOR_DIGITS: Record<Currency, number> = {
    RUB: 2,
    USD: 2,
    EUR: 2,
}

/** A plain decimal: no sign, exponent, spaces or leading zeros, at most 15 digits before the point. */
const DECIMAL = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]+))?$/

/**
 * An amount in minor units (kopecks, cents) as an exact integer, or undefined
 * when it is not a plain decimal or has more digits after the point than the
 * currency has. Nothing is rounded: a JSON number is read through its shortest
 * decimal form, so 499.999 stays 499.999 and is refused instead of becoming 500.
 */
export function toMinorUnits(amount: string | number, currency: Currency): bigint | undefined {
    const text = typeof amount === 'number' ? (Number.isFinite(amount) ? String(amount) : '') : amount
    const match = DECIMAL.exec(text)
    if (!match) return undefined
    const [, whole = '0', fraction = ''] = match
    const digits = MINOR_DIGITS[currency]
    if (fraction.length > digits) return undefined
    return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0')
}
