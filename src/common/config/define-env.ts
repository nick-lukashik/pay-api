import { z } from 'zod'

/** Variables every service reads. */
export const baseEnvSchema = z.object({
    NODE_ENV: z
        .enum([
            'development',
            'test',
            'production',
        ])
        .default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
        .enum([
            'fatal',
            'error',
            'warn',
            'info',
            'debug',
            'trace',
            'silent',
        ])
        .default('info'),
    APP_VERSION: z.string().min(1).max(64).default('dev'),
    /** Proxy hops in front of the service; client IPs come from X-Forwarded-For. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    /** Wait after SIGTERM before closing, so the load balancer drops the pod. */
    SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(0),
})

export const postgresEnvSchema = z.object({
    DATABASE_URL: z.url({
        protocol: /^postgres(ql)?$/,
    }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
})

export const redisEnvSchema = z.object({
    REDIS_URL: z.url({
        protocol: /^rediss?$/,
    }),
})

export const rabbitEnvSchema = z.object({
    RABBITMQ_URL: z.url({
        protocol: /^amqps?$/,
    }),
})

export const metricsEnvSchema = z.object({
    /** Port of the separate `GET /metrics` listener; 0 turns it off. */
    METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9464),
})

/**
 * One validated, cached view of process.env. Secrets have no defaults: a
 * missing one stops the process at startup with the list of every invalid
 * variable (names and reasons only, never values).
 */
export function defineEnv<S extends z.ZodObject>(schema: S) {
    let cached: z.output<S> | undefined
    const read = (): z.output<S> => {
        if (cached) return cached
        const result = schema.safeParse(process.env)
        if (!result.success) {
            const lines = result.error.issues.map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            throw new Error(`Invalid environment:\n${lines.join('\n')}`)
        }
        cached = result.data
        return cached
    }
    return Object.assign(read, {
        schema,
        reset: () => {
            cached = undefined
        },
    })
}
