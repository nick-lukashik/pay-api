import { describe, expect, it } from 'vitest'
import { envSchema } from './env.js'

const core = {
    DATABASE_URL: 'postgres://u:p@db.example.com/app',
    RABBITMQ_URL: 'amqp://u:p@mq.example.com',
    ID_INTERNAL_TOKEN: 'i'.repeat(32),
    WALLET_INTERNAL_TOKEN: 'w'.repeat(32),
}

describe('the env of the core', () => {
    it('does not read the variables of a provider', () => {
        const parsed = envSchema.parse({
            ...core,
            PAY_PROVIDER: 'fake',
            LAVA_API_URL: 'not-a-url',
            LAVA_OFFER_COINS_100: '',
        })
        expect(parsed.PAY_PROVIDER).toBe('fake')
        expect(Object.keys(parsed).filter(key => key.startsWith('LAVA_'))).toEqual([])
    })

    it('leaves the variables of the selected provider to its adapter', () => {
        expect(
            envSchema.safeParse({
                ...core,
                PAY_PROVIDER: 'lava',
            }).success,
        ).toBe(true)
    })

    it('takes only a provider of the registry', () => {
        expect(
            envSchema.safeParse({
                ...core,
                PAY_PROVIDER: 'stripe',
            }).success,
        ).toBe(false)
    })
})
