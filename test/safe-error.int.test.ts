import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { safeErrorMessage, serializeError } from '../src/common/logging/safe-error.js'

const SECRET = 'anna@example.com'

describe('errors of real queries', () => {
    const client = new pg.Client({
        connectionString: inject('databaseUrl'),
    })
    const db = drizzle({
        client,
    })

    beforeAll(async () => {
        await client.connect()
        await client.query('create temp table people (email text unique)')
    })

    afterAll(async () => {
        await client.end()
    })

    const failure = async (query: Promise<unknown>) =>
        query.then(
            () => undefined,
            (error: unknown) => error,
        )

    it('keeps the values of a unique violation out of the log', async () => {
        const insert = () => db.execute(sql`insert into people (email) values (${SECRET})`)
        await insert()
        const error = await failure(insert())
        const text = JSON.stringify(serializeError(error))
        // The raw error does carry the value: this is what the serializer is for.
        expect((error as Error).message).toContain(SECRET)
        expect(text).not.toContain(SECRET)
        expect(text).toContain('people_email_key')
    })

    it('keeps the input of a data exception out of the log', async () => {
        const error = await failure(db.execute(sql`select ${SECRET}::uuid`))
        const text = JSON.stringify(serializeError(error))
        expect(text).not.toContain(SECRET)
        expect(text).toContain('22P02')
        expect(safeErrorMessage(error)).not.toContain(SECRET)
    })
})
