import { DrizzleQueryError } from 'drizzle-orm/errors'
import { pino, stdSerializers } from 'pino'
import { describe, expect, it } from 'vitest'
import { safeErrorMessage, serializeError } from './safe-error.js'

const SECRET = 'anna@example.com'

const postgresError = (message: string, fields: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), {
        code: '23505',
        ...fields,
    })

const failedInsert = () =>
    new DrizzleQueryError(
        'insert into "users" ("email") values ($1)',
        [
            SECRET,
        ],
        postgresError('duplicate key value violates unique constraint "users_email_uq"', {
            detail: `Key (email)=(${SECRET}) already exists.`,
        }),
    )

/** What pino really writes for `{ err }` with this serializer. */
function logged(err: unknown) {
    const lines: string[] = []
    const logger = pino(
        {
            serializers: {
                err: serializeError,
            },
        },
        {
            write: line => {
                lines.push(line)
            },
        },
    )
    logger.error(
        {
            err,
        },
        'Request failed',
    )
    return lines[0] ?? ''
}

describe('serializeError', () => {
    it('drops the values of a failed query and keeps the query and the cause', () => {
        const line = logged(failedInsert())
        expect(line).not.toContain(SECRET)
        expect(line).toContain('insert into')
        expect(line).toContain('users_email_uq')
    })

    it('drops the values from the stack when wrapped, as pino-http does', () => {
        const serialize = stdSerializers.wrapErrorSerializer(serializeError)
        const text = JSON.stringify(serialize(failedInsert()))
        expect(text).not.toContain(SECRET)
        expect(text).toContain('users_email_uq')
    })

    it('drops the values when the query error is only a cause', () => {
        const line = logged(
            new Error('Handler failed', {
                cause: failedInsert(),
            }),
        )
        expect(line).not.toContain(SECRET)
        expect(line).toContain('Handler failed')
    })

    it('drops the fields of a Postgres error that quote a row', () => {
        const line = logged(
            postgresError('violates check constraint', {
                detail: `Failing row contains (${SECRET}).`,
                where: `SQL function with ${SECRET}`,
                internalQuery: `select '${SECRET}'`,
            }),
        )
        expect(line).not.toContain(SECRET)
        expect(line).toContain('violates check constraint')
    })

    it('drops the input Postgres quotes in a data exception', () => {
        const line = logged(
            postgresError(`invalid input syntax for type uuid: "${SECRET}"`, {
                code: '22P02',
            }),
        )
        expect(line).not.toContain(SECRET)
        expect(line).toContain('22P02')
    })

    it('leaves another error as it is', () => {
        const error = new Error('plain')
        expect(serializeError(error).message).toBe('plain')
        expect(serializeError(error).stack).toBe(error.stack)
    })
})

describe('safeErrorMessage', () => {
    it('gives the text of an error without values', () => {
        const text = safeErrorMessage(failedInsert())
        expect(text).not.toContain(SECRET)
        expect(text).toContain('insert into')
        expect(text).toContain('users_email_uq')
    })

    it('gives the text of something that is not an error', () => {
        expect(safeErrorMessage('refused')).toBe('refused')
    })
})
