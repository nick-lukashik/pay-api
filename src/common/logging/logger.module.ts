import type { IncomingMessage } from 'node:http'
import type { DynamicModule, InjectionToken } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { stdTimeFunctions } from 'pino'
import { currentContext } from '../context/request-context.js'
import { requestIdOf } from '../http/request-id.js'

export type LoggingOptions = {
    service: string
    version: string
    level: string
}

/** Paths of secrets that must never reach a log line, whatever logs them. */
export const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
    'password',
    'token',
    'secret',
    '*.password',
    '*.token',
    '*.secret',
    '*.connectionString',
]

/**
 * JSON lines to stdout only. Every line of a request carries `requestId`;
 * lines of a consumed event or job carry its `correlationId`. Probes are
 * not access-logged.
 */
export function createLoggerModule(options: {
    inject?: InjectionToken[]
    useFactory: (...args: never[]) => LoggingOptions
}): DynamicModule {
    return LoggerModule.forRootAsync({
        inject: options.inject ?? [],
        useFactory: (...args: unknown[]) => {
            const logging = options.useFactory(...(args as never[]))
            return {
                pinoHttp: {
                    level: logging.level,
                    base: {
                        service: logging.service,
                        version: logging.version,
                    },
                    timestamp: stdTimeFunctions.isoTime,
                    formatters: {
                        level: (label: string) => ({
                            level: label,
                        }),
                    },
                    genReqId: requestIdOf,
                    quietReqLogger: true,
                    customAttributeKeys: {
                        reqId: 'requestId',
                    },
                    mixin: () => {
                        const context = currentContext()
                        return context
                            ? {
                                  correlationId: context.correlationId,
                              }
                            : {}
                    },
                    customLogLevel: (_req, res, error) =>
                        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
                    autoLogging: {
                        ignore: (req: IncomingMessage) => req.url?.startsWith('/health/') ?? false,
                    },
                    serializers: {
                        req: (req: { method: string; url: string }) => ({
                            method: req.method,
                            url: req.url,
                        }),
                        res: (res: { statusCode: number }) => ({
                            statusCode: res.statusCode,
                        }),
                    },
                    redact: {
                        paths: REDACT_PATHS,
                        censor: '[REDACTED]',
                    },
                },
            }
        },
    })
}
