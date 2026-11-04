import { setTimeout as sleep } from 'node:timers/promises'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/** Injection tokens: `@Inject(DB) db: Db` (Drizzle) and `@Inject(PG_POOL) pool: pg.Pool`. */
export const DB = Symbol('DB')
export const PG_POOL = Symbol('PG_POOL')

export type AnyDb = NodePgDatabase<Record<string, unknown>>
/** A transaction handle of `db.transaction(async (tx) => ...)`. */
export type TxOf<D extends AnyDb> = Parameters<Parameters<D['transaction']>[0]>[0]

/**
 * Time budgets of the service contract: a dependency that hangs fails the
 * request fast instead of filling the pool. The server enforces the first
 * SQL limits per connection; the pool bounds acquisition and client reply wait.
 */
export const DATABASE_TIMEOUTS = {
    /** One statement. */
    statementMs: 5_000,
    /** Reply deadline; destroys a stuck connection after the server budget. */
    replyMs: 6_000,
    /** Waiting for a row or table lock held by another transaction. */
    lockMs: 2_000,
    /** A transaction left open without a statement (a leaked client) is ended by the server. */
    idleInTransactionMs: 10_000,
    /** Waiting for a free pool connection, or for a new one to connect. */
    acquireMs: 2_000,
} as const

export type DatabaseOptions = {
    url: string
    /** Pool size per process (the bound); keep replicas × max under the server's max_connections. */
    max?: number
    /** Shown in pg_stat_activity. */
    applicationName: string
}

export function createPool(options: DatabaseOptions) {
    const pool = new pg.Pool({
        connectionString: options.url,
        pipeline: false,
        max: options.max ?? 10,
        application_name: options.applicationName,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: DATABASE_TIMEOUTS.acquireMs,
        statement_timeout: DATABASE_TIMEOUTS.statementMs,
        lock_timeout: DATABASE_TIMEOUTS.lockMs,
        idle_in_transaction_session_timeout: DATABASE_TIMEOUTS.idleInTransactionMs,
    })
    pool.on('connect', client => {
        // Preserve pg's callback and Promise overloads (Drizzle uses both).
        client.query = new Proxy(client.query, {
            apply(query, receiver, args) {
                const timer = setTimeout(() => {
                    // With pipelining off, end() destroys the socket of an active
                    // query. pg rejects pending work and the pool removes the client.
                    void client.end().catch(() => {})
                }, DATABASE_TIMEOUTS.replyMs)
                const finish = () => clearTimeout(timer)
                const callback = args.at(-1)
                if (typeof callback === 'function') {
                    args[args.length - 1] = (...values: unknown[]) => {
                        finish()
                        return callback(...values)
                    }
                }
                try {
                    const result = Reflect.apply(query, receiver, args)
                    if (result instanceof Promise) return result.finally(finish)
                    if (result && typeof result.once === 'function') {
                        result.once('end', finish)
                        result.once('error', finish)
                    }
                    return result
                } catch (error) {
                    finish()
                    throw error
                }
            },
        })
    })
    return pool
}

export function createDb<TSchema extends Record<string, unknown>>(pool: pg.Pool, schema: TSchema) {
    return drizzle({
        client: pool,
        schema,
    })
}

export type DatabaseFailure = 'lock_timeout' | 'statement_timeout' | 'pool_timeout' | 'unavailable'

const FAILURE_BY_SQLSTATE: Record<string, DatabaseFailure> = {
    // lock_not_available: lock_timeout
    '55P03': 'lock_timeout',
    // query_canceled: statement_timeout
    '57014': 'statement_timeout',
    // idle_in_transaction_session_timeout ended the session
    '25P03': 'unavailable',
    // admin_shutdown, crash_shutdown, cannot_connect_now, too_many_connections
    '57P01': 'unavailable',
    '57P02': 'unavailable',
    '57P03': 'unavailable',
    '53300': 'unavailable',
}

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'EPIPE',
])

/**
 * Why a query failed when the cause is the database being slow, contended or
 * gone (not the query or the data); `undefined` otherwise. Unwraps Drizzle's
 * `DrizzleQueryError` and other `cause` chains.
 */
export function databaseFailure(error: unknown): DatabaseFailure | undefined {
    let current: unknown = error
    for (let depth = 0; depth < 5 && current; depth++) {
        const { code, message, cause } = current as {
            code?: unknown
            message?: unknown
            cause?: unknown
        }
        if (typeof code === 'string') {
            const failure = FAILURE_BY_SQLSTATE[code]
            if (failure) return failure
            // Class 08: connection exception.
            if (code.startsWith('08') || NETWORK_CODES.has(code)) return 'unavailable'
        }
        if (typeof message === 'string') {
            // pg-pool: no connection became free (or connected) within connectionTimeoutMillis.
            if (message === 'timeout exceeded when trying to connect') return 'pool_timeout'
            if (message.startsWith('Connection terminated')) return 'unavailable'
        }
        current = cause
    }
    return undefined
}

/** PostgreSQL unique_violation (optionally of one constraint), as thrown through Drizzle. */
export function isUniqueViolation(error: unknown, constraint?: string) {
    const cause =
        (
            error as {
                cause?: unknown
            }
        )?.cause ?? error
    const pgError = cause as {
        code?: string
        constraint?: string
    }
    return pgError?.code === '23505' && (!constraint || pgError.constraint === constraint)
}

/**
 * Lock waits of migrations. A DDL statement waiting for a lock holds up every
 * later query on that table (Postgres queues them behind it), so a migration
 * waits less than the app's own lock budget (`DATABASE_TIMEOUTS.lockMs`): the
 * app's queries get through, and the migration tries again a moment later.
 */
export const MIGRATION_LOCKS = {
    /** One lock wait of a migration statement. */
    timeoutMs: 1_000,
    /** Runs before giving up: the Job then fails and the rollout stops. */
    attempts: 10,
    /** Pause before the next run: 1 s, 2 s, … at most 10 s (about 1 min in all). */
    retryDelayMs: (attempt: number) => Math.min(10_000, attempt * 1_000),
} as const

export type MigrationOptions = {
    lockTimeoutMs?: number
    attempts?: number
    retryDelayMs?: (attempt: number) => number
    /** Called before each pause, e.g. to log it. */
    onRetry?: (attempt: number, delayMs: number) => void
}

/**
 * Applies the SQL migrations generated by drizzle-kit over one dedicated
 * connection (DDL never shares the application pool). Drizzle applies every
 * pending migration in one transaction, so a lock timeout rolls all of them
 * back and the run is repeated (`MIGRATION_LOCKS`). Any other error fails at once.
 */
export async function runMigrations(url: string, migrationsFolder: string, options: MigrationOptions = {}) {
    const attempts = options.attempts ?? MIGRATION_LOCKS.attempts
    const retryDelayMs = options.retryDelayMs ?? MIGRATION_LOCKS.retryDelayMs
    for (let attempt = 1; ; attempt++) {
        const client = new pg.Client({
            connectionString: url,
            lock_timeout: options.lockTimeoutMs ?? MIGRATION_LOCKS.timeoutMs,
        })
        await client.connect()
        try {
            await migrate(
                drizzle({
                    client,
                }),
                {
                    migrationsFolder,
                },
            )
            return
        } catch (error) {
            if (databaseFailure(error) !== 'lock_timeout' || attempt >= attempts) throw error
        } finally {
            await client.end()
        }
        const delayMs = retryDelayMs(attempt)
        options.onRetry?.(attempt, delayMs)
        await sleep(delayMs)
    }
}
