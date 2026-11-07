import { stdSerializers } from 'pino'

/** Fields of a query error or a Postgres error that quote values of a row or a query. */
const VALUE_FIELDS = [
    'params',
    'detail',
    'where',
    'internalQuery',
]

const MAX_CAUSES = 5

type ErrorLike = {
    message: string
    query?: unknown
    params?: unknown
    code?: unknown
    cause?: unknown
}

const isErrorLike = (value: unknown): value is ErrorLike =>
    typeof value === 'object' && value !== null && typeof (value as ErrorLike).message === 'string'

/**
 * The text to log instead of an error's own message, when that message quotes
 * values: Drizzle puts the parameters in it, and Postgres quotes the input in
 * data exceptions (class 22), e.g. `invalid input syntax for type uuid: "..."`.
 */
function safeText(error: ErrorLike): string | undefined {
    if ('query' in error && 'params' in error) return `Failed query: ${String(error.query)}`
    if (typeof error.code === 'string' && error.code.startsWith('22')) return `Invalid data (SQLSTATE ${error.code})`
    return undefined
}

/**
 * The `err` serializer of pino: the standard one, without the values of a failed
 * query in the message, the stack or the fields, also in a chain of causes.
 * pino-http passes it the standard result, whose `raw` is the original error.
 */
export function serializeError(input: unknown) {
    const error =
        (
            input as
                | {
                      raw?: unknown
                  }
                | null
                | undefined
        )?.raw ?? input
    const serialized = stdSerializers.err(error as Error)
    if (!isErrorLike(error)) return serialized
    for (const field of VALUE_FIELDS) delete serialized[field]
    let current: unknown = error
    for (let depth = 0; depth < MAX_CAUSES && isErrorLike(current); depth++) {
        const safe = safeText(current)
        if (safe) {
            serialized.message = serialized.message.replaceAll(current.message, safe)
            if (serialized.stack) serialized.stack = serialized.stack.replaceAll(current.message, safe)
        }
        current = current.cause
    }
    return serialized
}

/** An error as text for a log field or a message header, without the values of a failed query. */
export function safeErrorMessage(error: unknown): string {
    return isErrorLike(error) ? serializeError(error).message : String(error)
}
