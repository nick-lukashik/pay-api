import { z } from 'zod'
import {
    baseEnvSchema,
    defineEnv,
    metricsEnvSchema,
    postgresEnvSchema,
    rabbitEnvSchema,
} from '../common/config/define-env.js'
import { providerNames } from '../providers/registry.js'

/**
 * Every variable of the core. The selected provider's own come from its env
 * block (src/providers/registry.ts); nothing else touches process.env.
 */
export const envSchema = baseEnvSchema
    .extend(postgresEnvSchema.shape)
    .extend(rabbitEnvSchema.shape)
    .extend(metricsEnvSchema.shape)
    .extend({
        /** Access tokens of id-api (JWKS, issuer, audience). */
        ID_JWKS_URL: z.url().default('http://id-api.prod.svc/.well-known/jwks.json'),
        TOKEN_ISSUER: z.url().default('https://id.nick-lukashik.com'),
        TOKEN_AUDIENCE: z.string().min(1).default('nick-lukashik'),
        /** id-api inside the cluster: the buyer's email for the provider. */
        ID_API_URL: z.url().default('http://id-api.prod.svc'),
        ID_INTERNAL_TOKEN: z.string().min(32),
        /** wallet-api inside the cluster: reconciliation asks it what the ledger has. */
        WALLET_API_URL: z.url().default('http://wallet-api.prod.svc'),
        WALLET_INTERNAL_TOKEN: z.string().min(32),
        /** How often reconciliation runs; 0 turns the timer off (tests run the rounds themselves). */
        RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
        /** The payment provider: a name of the registry, whose env block is then validated. */
        PAY_PROVIDER: z.enum(providerNames).default('fake'),
    })

export type Env = z.output<typeof envSchema>

export const env = defineEnv(envSchema)
