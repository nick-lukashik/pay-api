import { registerAs } from '@nestjs/config'
import { env } from './env.js'

/** Service name: logs, metrics, connection names. */
export const SERVICE_NAME = 'pay-api'

export const appConfig = registerAs('app', () => ({
    service: SERVICE_NAME,
    nodeEnv: env().NODE_ENV,
    production: env().NODE_ENV === 'production',
    port: env().PORT,
    version: env().APP_VERSION,
    logLevel: env().LOG_LEVEL,
    trustProxyHops: env().TRUST_PROXY_HOPS,
    shutdownDelayMs: env().SHUTDOWN_DELAY_MS,
    metricsPort: env().METRICS_PORT,
}))

export const dbConfig = registerAs('db', () => ({
    url: env().DATABASE_URL,
    max: env().DATABASE_POOL_MAX,
}))

export const rabbitConfig = registerAs('rabbit', () => ({
    url: env().RABBITMQ_URL,
}))

export const authConfig = registerAs('auth', () => ({
    jwksUrl: env().ID_JWKS_URL,
    issuer: env().TOKEN_ISSUER,
    audience: env().TOKEN_AUDIENCE,
    idApiUrl: env().ID_API_URL,
    idInternalToken: env().ID_INTERNAL_TOKEN,
}))

export const payConfig = registerAs('pay', () => ({
    provider: env().PAY_PROVIDER,
    idWebUrl: env().ID_WEB_URL,
    lava: {
        apiUrl: env().LAVA_API_URL,
        apiKey: env().LAVA_API_KEY ?? '',
        webhookSecret: env().LAVA_WEBHOOK_SECRET ?? '',
        offers: {
            LAVA_OFFER_COINS_100: env().LAVA_OFFER_COINS_100,
            LAVA_OFFER_COINS_550: env().LAVA_OFFER_COINS_550,
            LAVA_OFFER_COINS_1200: env().LAVA_OFFER_COINS_1200,
        } as Record<string, string | undefined>,
    },
}))
