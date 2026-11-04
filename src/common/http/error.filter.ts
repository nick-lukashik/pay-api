import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { Request, Response } from 'express'
import { type DatabaseFailure, databaseFailure } from '../database/database.js'
import { AppError, type ErrorBody, type ErrorCode, errorStatus } from './app-error.js'

type Rendered = Omit<ErrorBody, 'requestId'> & {
    status: number
}

/**
 * Errors thrown by body-parser before Nest sees the request (too large,
 * unsupported charset) carry a safe 4xx `status` and `expose: true`.
 */
function parserError(exception: unknown) {
    const { expose, status } = (exception ?? {}) as {
        expose?: unknown
        status?: unknown
    }
    return expose === true && typeof status === 'number' && status >= 400 && status < 500 ? status : undefined
}

const codeOf = (status: number): ErrorCode => {
    if (status === HttpStatus.UNAUTHORIZED) return 'UNAUTHORIZED'
    if (status === HttpStatus.FORBIDDEN) return 'FORBIDDEN'
    if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND'
    if (status === HttpStatus.CONFLICT) return 'CONFLICT'
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) return 'PAYLOAD_TOO_LARGE'
    return status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED'
}

/** Safe for clients: what happened, never the SQL. */
const DATABASE_MESSAGES: Record<DatabaseFailure, string> = {
    lock_timeout: 'Database lock wait timed out, retry later',
    statement_timeout: 'Database query timed out, retry later',
    pool_timeout: 'Database is busy, retry later',
    unavailable: 'Database unavailable, retry later',
}

export function renderError(exception: unknown): Rendered {
    if (exception instanceof AppError) {
        return {
            status: exception.status,
            code: exception.code,
            message: exception.message,
            ...(exception.details?.length
                ? {
                      details: exception.details,
                  }
                : {}),
        }
    }
    const status = exception instanceof HttpException ? exception.getStatus() : parserError(exception)
    // Any 429, e.g. ThrottlerException; its own message names the class.
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
        return {
            status,
            code: 'RATE_LIMITED',
            message: 'Too many requests',
        }
    }
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
        return {
            status,
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body too large',
        }
    }
    if (status !== undefined && status < 500) {
        const message = exception instanceof Error && exception.message ? exception.message : 'Bad request'
        return {
            status,
            code: codeOf(status),
            message,
        }
    }
    // E.g. the identity keys are unreachable (AccessTokenGuard): safe to retry.
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        return {
            status,
            code: 'UNAVAILABLE',
            message: exception instanceof Error && exception.message ? exception.message : 'Service unavailable',
        }
    }
    const failure = databaseFailure(exception)
    if (failure) {
        return {
            status: errorStatus.UNAVAILABLE,
            code: 'UNAVAILABLE',
            message: DATABASE_MESSAGES[failure],
        }
    }
    return {
        status: errorStatus.INTERNAL,
        code: 'INTERNAL',
        message: 'Internal server error',
    }
}

/**
 * Renders every error as the contract body; unknown errors become INTERNAL and
 * are logged. A database over its time budget or gone is a 503 UNAVAILABLE,
 * logged by reason only and reported to `onDatabaseFailure` (a metric).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger('ErrorFilter')

    constructor(private readonly onDatabaseFailure?: (failure: DatabaseFailure) => void) {}

    catch(exception: unknown, host: ArgumentsHost) {
        const http = host.switchToHttp()
        const request = http.getRequest<
            Request & {
                id?: string
            }
        >()
        const response = http.getResponse<Response>()

        // Probes keep the terminus body: per-dependency status for Kubernetes and humans.
        if (exception instanceof HttpException && request.path.startsWith('/health/')) {
            response.status(exception.getStatus()).json(exception.getResponse())
            return
        }

        const { status, ...rest } = renderError(exception)
        const failure = status === errorStatus.UNAVAILABLE ? databaseFailure(exception) : undefined
        if (failure) {
            this.onDatabaseFailure?.(failure)
            this.logger.warn(
                {
                    reason: failure,
                    method: request.method,
                    url: request.originalUrl,
                },
                'Database unavailable for a request',
            )
        } else if (status >= 500) {
            this.logger.error(
                {
                    err: exception,
                    method: request.method,
                    url: request.originalUrl,
                },
                'Request failed',
            )
        }
        const body: ErrorBody = {
            ...rest,
            requestId: String(request.id ?? ''),
        }
        response.status(status).json(body)
    }
}
