import {
    Controller,
    type DynamicModule,
    Get,
    Global,
    type InjectionToken,
    Logger,
    Module,
    VERSION_NEUTRAL,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { HealthCheck, HealthCheckService, HealthIndicatorService, TerminusModule } from '@nestjs/terminus'
import { DependencyDownError, type HealthDetails, type HealthEntry, HealthRegistry } from './health.registry.js'

const CHECK_TIMEOUT_MS = 2_000

/**
 * GET /health/live: the process answers; never checks dependencies, so an
 * outage of one does not restart every pod.
 * GET /health/ready: every required dependency (Postgres) answers within 2 s,
 * else 503 (also 503 while shutting down, so traffic drains first). A
 * degradable one (Redis, RabbitMQ) that fails is reported as `degraded` in
 * the body and the status stays 200: the service still does its core job.
 */
@ApiExcludeController()
@Controller({
    path: 'health',
    version: VERSION_NEUTRAL,
})
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly indicators: HealthIndicatorService,
        private readonly registry: HealthRegistry,
    ) {}

    @Get('live')
    @HealthCheck({
        swaggerDocumentation: false,
    })
    live() {
        return this.health.check([])
    }

    @Get('ready')
    @HealthCheck({
        swaggerDocumentation: false,
    })
    ready() {
        return this.health.check(
            this.registry.entries().map(
                ([name, entry]) =>
                    () =>
                        this.indicator(name, entry),
            ),
        )
    }

    private async indicator(name: string, { check, required }: HealthEntry) {
        const session = this.indicators.check(name)
        let details: HealthDetails = {}
        const result = await session
            .attempt(async () => {
                try {
                    const value = await check()
                    return typeof value === 'object' && value !== null ? (value as HealthDetails) : undefined
                } catch (error) {
                    if (error instanceof DependencyDownError) details = error.details
                    throw error
                }
            })
            .withTimeout(CHECK_TIMEOUT_MS)
        const outcome = result[name]
        if (outcome?.status !== 'down') return result
        const { status: _down, ...data } = outcome
        if (required)
            return session.down({
                ...details,
                ...data,
            })
        return session.degraded({
            ...details,
            ...data,
        })
    }
}

/** A dependency that is down is expected during an outage: a warning, not an error. */
class HealthCheckLogger extends Logger {
    constructor() {
        super('HealthCheck')
    }

    override error(message: unknown) {
        this.warn(message)
    }
}

@Global()
@Module({})
export class HealthModule {
    static forRootAsync(options: {
        inject?: InjectionToken[]
        useFactory: (...args: never[]) => {
            shutdownDelayMs: number
        }
    }): DynamicModule {
        return {
            module: HealthModule,
            imports: [
                TerminusModule.forRootAsync({
                    inject: options.inject ?? [],
                    useFactory: (...args: unknown[]) => ({
                        errorLogStyle: 'json' as const,
                        logger: new HealthCheckLogger(),
                        gracefulShutdownTimeoutMs: options.useFactory(...(args as never[])).shutdownDelayMs,
                    }),
                }),
            ],
            controllers: [
                HealthController,
            ],
            providers: [
                HealthRegistry,
            ],
            exports: [
                HealthRegistry,
            ],
        }
    }
}
