import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer } from '@testcontainers/rabbitmq'
import { RedisContainer } from '@testcontainers/redis'
import type { TestProject } from 'vitest/node'
import { migrateDatabase } from '../src/db/migrations.js'
import { IMAGES } from './containers.js'

declare module 'vitest' {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only with an interface
    export interface ProvidedContext {
        databaseUrl: string
        redisUrl: string
        rabbitmqUrl: string
    }
}

type Urls = {
    databaseUrl: string
    redisUrl: string
    rabbitmqUrl: string
}

/**
 * Ready services instead of Testcontainers: TEST_DATABASE_URL, TEST_REDIS_URL
 * and TEST_RABBITMQ_URL, exported by the org build workflow for its service
 * containers. Plain DATABASE_URL and the like are never used: the tests truncate
 * tables, so a shell that happens to export them cannot hit a real database.
 */
function readyServices(env: NodeJS.ProcessEnv): Urls | undefined {
    const pick = (prefix: string): Partial<Urls> => ({
        databaseUrl: env[`${prefix}DATABASE_URL`],
        redisUrl: env[`${prefix}REDIS_URL`],
        rabbitmqUrl: env[`${prefix}RABBITMQ_URL`],
    })
    const complete = (urls: Partial<Urls>): urls is Urls =>
        Boolean(urls.databaseUrl && urls.redisUrl && urls.rabbitmqUrl)
    const explicit = pick('TEST_')
    return complete(explicit) ? explicit : undefined
}

/**
 * Starts Postgres, Redis and RabbitMQ once per run with Testcontainers and
 * applies the migrations, unless ready services are given (see above).
 */
export default async function setup(project: TestProject) {
    let urls: Urls
    let teardown = async () => {}

    const ready = readyServices(process.env)
    if (ready) {
        urls = ready
    } else {
        const [postgres, redis, rabbitmq] = await Promise.all([
            new PostgreSqlContainer(IMAGES.postgres).start(),
            new RedisContainer(IMAGES.redis).start(),
            new RabbitMQContainer(IMAGES.rabbitmq).start(),
        ])
        urls = {
            databaseUrl: postgres.getConnectionUri(),
            redisUrl: redis.getConnectionUrl(),
            rabbitmqUrl: rabbitmq.getAmqpUrl(),
        }
        teardown = async () => {
            await Promise.all([
                postgres.stop(),
                redis.stop(),
                rabbitmq.stop(),
            ])
        }
    }

    await migrateDatabase(urls.databaseUrl)
    project.provide('databaseUrl', urls.databaseUrl)
    project.provide('redisUrl', urls.redisUrl)
    project.provide('rabbitmqUrl', urls.rabbitmqUrl)
    return teardown
}
