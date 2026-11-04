import { describe, expect, it } from 'vitest'
import { toMinorUnits } from './money.js'

describe('toMinorUnits', () => {
    it.each([
        [
            '500',
            50_000n,
        ],
        [
            500,
            50_000n,
        ],
        [
            '4.99',
            499n,
        ],
        [
            4.99,
            499n,
        ],
        [
            '4.9',
            490n,
        ],
        [
            40254.19,
            4_025_419n,
        ],
        [
            '0',
            0n,
        ],
        [
            '999999999999999.99',
            99_999_999_999_999_999n,
        ],
    ])('reads %j exactly', (amount, minor) => {
        expect(toMinorUnits(amount, 'RUB')).toBe(minor)
    })

    it.each([
        '500.001',
        499.999,
        0.1 + 0.2,
        '5e2',
        1e21,
        0.0000001,
        '-500',
        -500,
        '+500',
        ' 500',
        '0500',
        '500.',
        '.5',
        '500,00',
        '0x1F4',
        '',
        '1000000000000000',
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])('refuses %j', amount => {
        expect(toMinorUnits(amount, 'USD')).toBeUndefined()
    })
})
