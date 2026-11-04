import { z } from 'zod'
import {
    baseEnvSchema,
    defineEnv,
    metricsEnvSchema,
    postgresEnvSchema,
    rabbitEnvSchema,
} from '../common/config/define-env.js'

/** Every variable this service reads. Nothing else touches process.env. */
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
        /** Where people come back after paying, and the fake checkout page. */
        ID_WEB_URL: z.url().default('https://id.nick-lukashik.com'),
        /** `fake` confirms payments without money (local, stage); `lava` is lava.top. */
        PAY_PROVIDER: z
            .enum([
                'fake',
                'lava',
            ])
            .default('fake'),
        /** Stage runs NODE_ENV=production with the fake provider on purpose. */
        PAY_ALLOW_FAKE: z.stringbool().default(false),
        LAVA_API_URL: z.url().default('https://gate.lava.top'),
        LAVA_API_KEY: z.string().optional(),
        /** The X-Api-Key Lava sends with webhooks; separate from the API key. */
        LAVA_WEBHOOK_SECRET: z.string().optional(),
        LAVA_OFFER_COINS_100: z.uuid().optional(),
        LAVA_OFFER_COINS_550: z.uuid().optional(),
        LAVA_OFFER_COINS_1200: z.uuid().optional(),
    })
    .refine(
        value =>
            value.PAY_PROVIDER !== 'lava'
            || Boolean(value.LAVA_API_KEY && value.LAVA_WEBHOOK_SECRET && value.LAVA_WEBHOOK_SECRET.length >= 32),
        {
            path: [
                'PAY_PROVIDER',
            ],
            message: 'lava needs LAVA_API_KEY and LAVA_WEBHOOK_SECRET (at least 32 characters)',
        },
    )
    .refine(value => !(value.PAY_PROVIDER === 'fake' && value.NODE_ENV === 'production' && !value.PAY_ALLOW_FAKE), {
        path: [
            'PAY_PROVIDER',
        ],
        message: 'the fake provider gives coins without money: in production only with PAY_ALLOW_FAKE=true (stage)',
    })

export type Env = z.output<typeof envSchema>

export const env = defineEnv(envSchema)
