import { afterEach, describe, expect, it } from 'vitest'
import { createProvider, providerNames } from './registry.js'

const lava = {
    LAVA_API_KEY: 'api-key',
    LAVA_WEBHOOK_SECRET: 's'.repeat(32),
}
const saved = {
    ...process.env,
}

afterEach(() => {
    process.env = {
        ...saved,
    }
})

describe('provider registry', () => {
    it('gives every adapter under its own name', () => {
        process.env = {
            ...lava,
        }
        for (const name of providerNames) expect(createProvider(name).name).toBe(name)
    })

    it('does not validate the env of an adapter that is not selected', () => {
        process.env = {
            LAVA_API_URL: 'not-a-url',
            LAVA_API_KEY: '',
            LAVA_WEBHOOK_SECRET: 'short',
            LAVA_OFFER_COINS_100: '',
        }
        expect(createProvider('fake').name).toBe('fake')

        process.env = {
            ...lava,
            ID_WEB_URL: 'not-a-url',
            PAY_ALLOW_FAKE: 'maybe',
            NODE_ENV: 'production',
        }
        expect(createProvider('lava').name).toBe('lava')
    })

    it.each([
        [
            'LAVA_API_KEY',
            {
                LAVA_WEBHOOK_SECRET: lava.LAVA_WEBHOOK_SECRET,
            },
        ],
        [
            'LAVA_API_KEY',
            {
                ...lava,
                LAVA_API_KEY: '',
            },
        ],
        [
            'LAVA_WEBHOOK_SECRET',
            {
                LAVA_API_KEY: lava.LAVA_API_KEY,
            },
        ],
        [
            'LAVA_WEBHOOK_SECRET',
            {
                ...lava,
                LAVA_WEBHOOK_SECRET: 'too-short-to-be-a-secret',
            },
        ],
        [
            'LAVA_OFFER_COINS_100',
            {
                ...lava,
                LAVA_OFFER_COINS_100: 'too-short-to-be-a-secret',
            },
        ],
    ])('stops on an invalid %s of the selected adapter, naming it but never its value', (variable, values) => {
        process.env = values
        const create = () => createProvider('lava')
        expect(create).toThrow(new RegExp(`Invalid environment:\\n.*${variable}`))
        expect(create).not.toThrow(/too-short-to-be-a-secret/)
    })

    it('keeps the fake provider out of production unless it is allowed', () => {
        process.env = {
            NODE_ENV: 'production',
        }
        expect(() => createProvider('fake')).toThrow(/PAY_ALLOW_FAKE/)
        process.env = {
            NODE_ENV: 'production',
            PAY_ALLOW_FAKE: 'true',
        }
        expect(createProvider('fake').name).toBe('fake')
    })
})
