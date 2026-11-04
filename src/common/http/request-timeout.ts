import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { type Observable, throwError, timeout } from 'rxjs'
import { AppError } from './app-error.js'

/** The whole-request budget of the service contract. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Answers 504 `TIMEOUT` (contract body) when a handler has not produced its
 * result within the budget, and stops waiting for it. The dependency budgets
 * (SQL statement and lock, pool wait, Redis) end the abandoned work soon
 * after; a write it already committed stays committed.
 */
export class RequestTimeoutInterceptor implements NestInterceptor {
    constructor(
        private readonly budgetMs = REQUEST_TIMEOUT_MS,
        private readonly onTimeout?: () => void,
    ) {}

    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            timeout({
                first: this.budgetMs,
                with: () => {
                    this.onTimeout?.()
                    return throwError(() => new AppError('TIMEOUT', 'Request timed out'))
                },
            }),
        )
    }
}
