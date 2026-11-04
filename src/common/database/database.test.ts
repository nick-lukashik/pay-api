import { describe, expect, it } from 'vitest'
import { databaseFailure, isUniqueViolation } from './database.js'

const pgError = (code: string) =>
    Object.assign(new Error('pg'), {
        code,
    })

describe('databaseFailure', () => {
    it('classifies the time budgets by SQLSTATE, also when wrapped by Drizzle', () => {
        expect(databaseFailure(pgError('55P03'))).toBe('lock_timeout')
        expect(
            databaseFailure(
                new Error('Failed query', {
                    cause: pgError('57014'),
                }),
            ),
        ).toBe('statement_timeout')
        expect(databaseFailure(new Error('timeout exceeded when trying to connect'))).toBe('pool_timeout')
    })

    it('treats a lost or refused connection as unavailable', () => {
        expect(databaseFailure(pgError('ECONNREFUSED'))).toBe('unavailable')
        expect(databaseFailure(pgError('57P01'))).toBe('unavailable')
        expect(databaseFailure(pgError('08006'))).toBe('unavailable')
        expect(databaseFailure(new Error('Connection terminated unexpectedly'))).toBe('unavailable')
    })

    it('leaves query and data errors alone', () => {
        expect(databaseFailure(pgError('23505'))).toBeUndefined()
        expect(databaseFailure(pgError('42P01'))).toBeUndefined()
        expect(databaseFailure(new Error('boom'))).toBeUndefined()
        expect(databaseFailure(undefined)).toBeUndefined()
        expect(isUniqueViolation(pgError('23505'))).toBe(true)
    })
})
