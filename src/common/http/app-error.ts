import { z } from 'zod'

/** Stable machine-readable error codes of the HTTP contract and their statuses. */
export const errorStatus = {
    VALIDATION_FAILED: 400,
    /** No valid access token: refresh and retry, or sign in. */
    UNAUTHORIZED: 401,
    /** Not enough coins on the wallet for a debit. */
    INSUFFICIENT_FUNDS: 402,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    /** The same idempotency key or ref with different data, or a state that forbids the change. */
    CONFLICT: 409,
    /** Well-formed, but refused by the domain (a wrong sign-in code). */
    UNPROCESSABLE: 422,
    /** The wallet is restricted (account suspended): no debits. */
    LOCKED: 423,
    PAYLOAD_TOO_LARGE: 413,
    RATE_LIMITED: 429,
    INTERNAL: 500,
    /** A dependency is down or over its time budget (lock, statement, pool wait); safe to retry later. */
    UNAVAILABLE: 503,
    /** The whole request exceeded its budget; a write may still have been applied. */
    TIMEOUT: 504,
} as const
export type ErrorCode = keyof typeof errorStatus

export type ErrorDetail = {
    path: string
    message: string
}

/** The body of every error response. */
export const errorBodySchema = z
    .object({
        code: z.enum(
            Object.keys(errorStatus) as [
                ErrorCode,
                ...ErrorCode[],
            ],
        ),
        message: z.string(),
        details: z
            .array(
                z.object({
                    path: z.string(),
                    message: z.string(),
                }),
            )
            .optional(),
        requestId: z.string(),
    })
    .meta({
        id: 'Error',
    })
export type ErrorBody = z.infer<typeof errorBodySchema>

/** A domain error with a stable code. Its message goes to clients: no secrets, SQL or stack. */
export class AppError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        readonly details?: ErrorDetail[],
        options?: {
            cause?: unknown
        },
    ) {
        super(message, options)
        this.name = 'AppError'
    }

    get status(): number {
        return errorStatus[this.code]
    }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`)
