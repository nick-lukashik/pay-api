import {
    type DynamicModule,
    Global,
    Inject,
    Injectable,
    type InjectionToken,
    Logger,
    Module,
    type OnApplicationShutdown,
    type OnModuleInit,
    Optional,
} from '@nestjs/common'
import type pg from 'pg'
import { HealthRegistry } from '../health/health.registry.js'
import { Metrics } from '../metrics/metrics.js'
import { createDb, createPool, type DatabaseOptions, DB, PG_POOL } from './database.js'

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger('Database')

    constructor(
        @Inject(PG_POOL) private readonly pool: pg.Pool,
        private readonly health: HealthRegistry,
        @Optional() metrics?: Metrics,
    ) {
        metrics?.gauge({
            name: 'db_pool_connections',
            help: 'Application pool: open connections (total), idle ones, and requests waiting for one (waiting).',
            labelNames: [
                'state',
            ],
            collect() {
                this.set(
                    {
                        state: 'total',
                    },
                    pool.totalCount,
                )
                this.set(
                    {
                        state: 'idle',
                    },
                    pool.idleCount,
                )
                this.set(
                    {
                        state: 'waiting',
                    },
                    pool.waitingCount,
                )
            },
        })
    }

    onModuleInit() {
        // Without a listener an idle client's error (server restart) kills the process.
        this.pool.on('error', error =>
            this.logger.warn(
                {
                    err: error.message,
                },
                'Idle PostgreSQL connection lost; the pool reconnects on next use',
            ),
        )
        // The one required dependency: without Postgres the service cannot do its job.
        this.health.register(
            'postgres',
            async () => {
                await this.pool.query('select 1')
            },
            {
                required: true,
            },
        )
    }

    async onApplicationShutdown() {
        await this.pool.end()
    }
}

/** node-postgres pool (`PG_POOL`) and the Drizzle handle (`DB`) over it. */
@Global()
@Module({})
export class DatabaseModule {
    static forRootAsync<TSchema extends Record<string, unknown>>(options: {
        schema: TSchema
        inject?: InjectionToken[]
        useFactory: (...args: never[]) => DatabaseOptions
    }): DynamicModule {
        return {
            module: DatabaseModule,
            providers: [
                {
                    provide: PG_POOL,
                    inject: options.inject ?? [],
                    useFactory: (...args: never[]) => createPool(options.useFactory(...args)),
                },
                {
                    provide: DB,
                    inject: [
                        PG_POOL,
                    ],
                    useFactory: (pool: pg.Pool) => createDb(pool, options.schema),
                },
                DatabaseLifecycle,
            ],
            exports: [
                PG_POOL,
                DB,
            ],
        }
    }
}
