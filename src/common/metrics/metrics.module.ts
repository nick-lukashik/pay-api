import { type DynamicModule, Global, type InjectionToken, Module } from '@nestjs/common'
import { HttpMetrics } from './http-metrics.js'
import { METRICS_OPTIONS, Metrics, type MetricsOptions } from './metrics.js'
import { MetricsServer } from './metrics-server.js'

/** Prometheus registry every module adds to, HTTP metrics and the `/metrics` listener. */
@Global()
@Module({})
export class MetricsModule {
    static forRootAsync(options: {
        inject?: InjectionToken[]
        useFactory: (...args: never[]) => MetricsOptions
    }): DynamicModule {
        return {
            module: MetricsModule,
            providers: [
                {
                    provide: METRICS_OPTIONS,
                    inject: options.inject ?? [],
                    useFactory: options.useFactory,
                },
                Metrics,
                HttpMetrics,
                MetricsServer,
            ],
            exports: [
                Metrics,
                HttpMetrics,
            ],
        }
    }
}
