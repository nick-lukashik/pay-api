import type { IncomingMessage, ServerResponse } from 'node:http'
import { Injectable, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { Metrics } from './metrics.js'

const METHODS = new Set([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
])
const UNMATCHED = Symbol('unmatched')

type RoutedRequest = IncomingMessage & {
    baseUrl?: string
    route?: {
        path?: unknown
    }
    [UNMATCHED]?: true
}

/** The route template (`/api/v1/notes/:id`), never the raw path: bounded cardinality. */
const routeOf = (req: RoutedRequest) =>
    !req[UNMATCHED] && typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched'

/** Request count and latency by method, route template and status class; probes left out. */
@Injectable()
export class HttpMetrics implements OnModuleInit {
    private readonly requests
    private readonly duration

    constructor(
        metrics: Metrics,
        private readonly adapterHost: HttpAdapterHost,
    ) {
        const labelNames = [
            'method',
            'route',
            'status_class',
        ] as const
        this.requests = metrics.counter({
            name: 'http_server_requests_total',
            help: 'HTTP requests by method, route template and status class.',
            labelNames,
        })
        this.duration = metrics.histogram({
            name: 'http_server_request_duration_seconds',
            help: 'HTTP request latency by method, route template and status class.',
            labelNames,
            buckets: [
                0.005,
                0.01,
                0.025,
                0.05,
                0.1,
                0.25,
                0.5,
                1,
                2.5,
                5,
                10,
            ],
        })
    }

    /**
     * Runs after the routes are registered and before Nest's not-found handler:
     * a request that reaches this middleware matched no route.
     */
    onModuleInit() {
        this.adapterHost.httpAdapter?.use((req: RoutedRequest, _res: ServerResponse, next: () => void) => {
            req[UNMATCHED] = true
            next()
        })
    }

    /** Express middleware mounted by `configureApp` before any route. */
    readonly middleware = (req: RoutedRequest, res: ServerResponse, next: () => void) => {
        const started = performance.now()
        res.once('finish', () => {
            const route = routeOf(req)
            if (route.startsWith('/health/')) return
            const method = req.method ?? ''
            const labels = {
                method: METHODS.has(method) ? method : 'other',
                route,
                status_class: `${Math.floor(res.statusCode / 100)}xx`,
            }
            this.requests.inc(labels)
            this.duration.observe(labels, (performance.now() - started) / 1000)
        })
        next()
    }
}
