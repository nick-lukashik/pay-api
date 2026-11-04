import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { baseEnvSchema, defineEnv, postgresEnvSchema } from './define-env.js'

const schema = baseEnvSchema.extend(postgresEnvSchema.shape)
const saved = {
    ...process.env,
}

afterEach(() => {
    process.env = {
        ...saved,
    }
})

describe('defineEnv', () => {
    it('applies defaults and coerces numbers', () => {
        process.env = {
            DATABASE_URL: 'postgres://u:p@db.example.com:5432/app',
        }
        const env = defineEnv(schema)()
        expect(env).toMatchObject({
            NODE_ENV: 'development',
            PORT: 4000,
            APP_VERSION: 'dev',
            DATABASE_POOL_MAX: 10,
        })
    })

    it('fails on a missing secret, naming the variable but never a value', () => {
        process.env = {
            PORT: 'not-a-port',
            LOG_LEVEL: 'loud',
        }
        const read = defineEnv(schema)
        expect(read).toThrow(/DATABASE_URL/)
        expect(read).toThrow(/PORT/)
        expect(read).toThrow(/LOG_LEVEL/)
        expect(read).not.toThrow(/not-a-port/)
    })

    it('caches the parsed result until reset', () => {
        process.env = {
            DATABASE_URL: 'postgres://u:p@db.example.com/app',
            PORT: '4001',
        }
        const read = defineEnv(
            z.object({
                PORT: z.coerce.number(),
            }),
        )
        expect(read().PORT).toBe(4001)
        process.env.PORT = '4002'
        expect(read().PORT).toBe(4001)
        read.reset()
        expect(read().PORT).toBe(4002)
    })
})
