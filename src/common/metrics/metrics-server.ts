import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { METRICS_OPTIONS, Metrics, type MetricsOptions } from './metrics.js'

/**
 * `GET /metrics` on its own port, never on the application port, so metrics
 * cannot leak through an ingress that routes the API.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger('Metrics')
    private server: Server | undefined

    constructor(
        @Inject(METRICS_OPTIONS) private readonly options: MetricsOptions,
        private readonly metrics: Metrics,
    ) {}

    async onApplicationBootstrap() {
        if (this.options.port === 0) return
        const server = createServer((req, res) => {
            void this.handle(req, res)
        })
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.options.port, () => {
                server.off('error', reject)
                resolve()
            })
        })
        this.server = server
        this.logger.log(
            {
                port: this.options.port,
            },
            'Metrics listener started',
        )
    }

    async onApplicationShutdown() {
        const server = this.server
        this.server = undefined
        if (!server) return
        await new Promise<void>(resolve => {
            server.close(() => resolve())
            // Prometheus keeps its connection open between scrapes.
            server.closeAllConnections()
        })
    }

    private async handle(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
            res.writeHead(404).end()
            return
        }
        try {
            const body = await this.metrics.scrape()
            res.writeHead(200, {
                'content-type': this.metrics.registry.contentType,
            }).end(body)
        } catch (error) {
            this.logger.error(
                {
                    err: (error as Error).message,
                },
                'Scrape failed',
            )
            res.writeHead(500).end()
        }
    }
}
