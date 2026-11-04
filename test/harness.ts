import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { sql } from 'drizzle-orm'
import { Logger } from 'nestjs-pino'
import request from 'supertest'
import { inject } from 'vitest'
import { configureApp } from '../src/app.setup.js'
import { DB } from '../src/common/database/database.js'
import { Metrics } from '../src/common/metrics/metrics.js'
import { env } from '../src/config/env.js'
import type { Db } from '../src/db/types.js'
import { AUDIENCE, type Identity, ISSUER } from './identity.js'

export type TestApp = Awaited<ReturnType<typeof startApp>>

/**
 * The real AppModule against the shared containers, listening on a random
 * port. Every file starts from empty tables and an empty Redis.
 */
export async function startApp(identity: Identity, overrides: Record<string, string> = {}) {
    Object.assign(process.env, {
        NODE_ENV: 'test',
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
        APP_VERSION: 'test',
        METRICS_PORT: '0',
        DATABASE_URL: inject('databaseUrl'),
        REDIS_URL: inject('redisUrl'),
        RABBITMQ_URL: inject('rabbitmqUrl'),
        ID_JWKS_URL: identity.jwksUrl,
        TOKEN_ISSUER: ISSUER,
        TOKEN_AUDIENCE: AUDIENCE,
        ID_API_URL: identity.url,
        ID_INTERNAL_TOKEN: identity.internalToken,
        ID_WEB_URL: 'https://id.example.test',
        PAY_PROVIDER: 'fake',
        ...overrides,
    })
    env.reset()

    const { AppModule } = await import('../src/app.module.js')
    const moduleRef = await Test.createTestingModule({
        imports: [
            AppModule,
        ],
    }).compile()
    const app = moduleRef.createNestApplication<NestExpressApplication>({
        bufferLogs: true,
    })
    app.useLogger(app.get(Logger))
    configureApp(app)
    await app.init()

    const db = app.get<Db>(DB)
    await db.execute(sql`truncate payments, webhook_events, outbox, inbox`)
    await app.listen(0, '127.0.0.1')
    const { registry } = app.get(Metrics)

    return {
        app,
        db,
        http: () => request(app.getHttpServer()),
        /** Sum of a metric's series that carry `labels` (0 when none). */
        metric: async (name: string, labels: Record<string, string> = {}) => {
            const metric = registry.getSingleMetric(name)
            if (!metric) throw new Error(`no metric ${name}`)
            const { values } = await metric.get()
            return values
                .filter(value => Object.entries(labels).every(([key, label]) => value.labels[key] === label))
                .reduce((sum, value) => sum + value.value, 0)
        },
        close: () => app.close(),
    }
}
