import { Inject, Injectable } from '@nestjs/common'
import {
    Counter,
    type CounterConfiguration,
    collectDefaultMetrics,
    Gauge,
    type GaugeConfiguration,
    Histogram,
    type HistogramConfiguration,
    Registry,
} from '@prometheus-io/client'

export type MetricsOptions = {
    /** The `service` label of every series. */
    service: string
    version: string
    /** Port of the separate `/metrics` listener; 0 turns it off. */
    port: number
}

export const METRICS_OPTIONS = Symbol('METRICS_OPTIONS')

type Own<C> = Omit<C, 'registers'>

/**
 * The application's own registry (not the library's global one, so an app
 * started twice in one process, as in tests, starts clean). Label values come
 * from small fixed sets only; ids belong in logs.
 */
@Injectable()
export class Metrics {
    readonly registry = new Registry()

    constructor(@Inject(METRICS_OPTIONS) options: MetricsOptions) {
        this.registry.setDefaultLabels({
            service: options.service,
        })
        collectDefaultMetrics({
            register: this.registry,
        })
        this.gauge({
            name: 'app_info',
            help: 'Always 1; the version label tells which build runs.',
            labelNames: [
                'version',
            ],
        }).set(
            {
                version: options.version,
            },
            1,
        )
    }

    counter<T extends string = never>(config: Own<CounterConfiguration<T>>) {
        return new Counter<T>({
            ...config,
            registers: [
                this.registry,
            ],
        })
    }

    gauge<T extends string = never>(config: Own<GaugeConfiguration<T>>) {
        return new Gauge<T>({
            ...config,
            registers: [
                this.registry,
            ],
        })
    }

    histogram<T extends string = never>(config: Own<HistogramConfiguration<T>>) {
        return new Histogram<T>({
            ...config,
            registers: [
                this.registry,
            ],
        })
    }

    scrape() {
        return this.registry.metrics()
    }
}
