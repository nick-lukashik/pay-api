import type { IncomingMessage, ServerResponse } from 'node:http'
import { StandardSchemaValidationPipe, VersioningType } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ErrorFilter } from './common/http/error.filter.js'
import { requestContext } from './common/http/request-id.js'
import { REQUEST_TIMEOUT_MS, RequestTimeoutInterceptor } from './common/http/request-timeout.js'
import { validationException } from './common/http/validation.js'
import { HttpMetrics } from './common/metrics/http-metrics.js'
import { Metrics } from './common/metrics/metrics.js'
import { setupOpenApi } from './common/openapi/openapi.js'
import { appConfig } from './config/config.js'

/** Largest request body (JSON or form) the parsers accept; larger is a 413 (service contract). */
export const BODY_LIMIT = '1mb'

/**
 * HTTP setup shared by main.ts and the integration tests: security headers,
 * request id, metrics, body limits, Zod validation, contract errors, the
 * request time budget, `/api/v1` routes, OpenAPI, graceful shutdown. CORS
 * stays off: browsers reach the API only through the web app's server.
 */
export function configureApp(app: NestExpressApplication) {
    const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY)
    const metrics = app.get(Metrics)

    // First, so every response carries the headers, errors from middleware too.
    app.useSecurityHeaders()
    app.set('trust proxy', config.trustProxyHops)
    app.use(requestContext)
    app.use((_req: IncomingMessage, res: ServerResponse, next: () => void) => {
        res.setHeader('x-app-version', config.version)
        next()
    })
    app.use(app.get(HttpMetrics).middleware)
    // Registered before Nest's defaults (100 kb), which are then skipped. Bodies
    // of other types are not read at all.
    app.useBodyParser('json', {
        limit: BODY_LIMIT,
    })
    app.useBodyParser('urlencoded', {
        limit: BODY_LIMIT,
        extended: true,
    })

    app.useGlobalPipes(
        new StandardSchemaValidationPipe({
            exceptionFactory: validationException,
        }),
    )
    const databaseFailures = metrics.counter({
        name: 'http_server_database_failures_total',
        help: 'Requests answered 503 because Postgres was over a time budget or unavailable, by reason.',
        labelNames: [
            'reason',
        ],
    })
    app.useGlobalFilters(
        new ErrorFilter(reason =>
            databaseFailures.inc({
                reason,
            }),
        ),
    )
    const timeouts = metrics.counter({
        name: 'http_server_request_timeouts_total',
        help: 'Requests answered 504 because they exceeded the whole-request budget.',
    })
    app.useGlobalInterceptors(new RequestTimeoutInterceptor(REQUEST_TIMEOUT_MS, () => timeouts.inc()))
    app.setGlobalPrefix('api', {
        exclude: [
            'health/live',
            'health/ready',
            'webhooks/(.*)',
        ],
    })
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
    })

    setupOpenApi(app, {
        title: config.service,
        version: config.version,
        ui: !config.production,
    })
    app.enableShutdownHooks()
    return app
}
