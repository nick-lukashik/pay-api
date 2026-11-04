import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { databaseFailure, runMigrations } from '../src/common/database/database.js'
import { migrationsFolder } from '../src/db/migrations.js'

const elapsedSince = (started: number) => performance.now() - started

/** Its own database: these tests add columns and record migrations. */
describe('migrations and locks', () => {
    const name = `migrations_${process.pid}_${Date.now()}`
    const admin = () =>
        new pg.Client({
            connectionString: inject('databaseUrl'),
        })
    const url = (() => {
        const parsed = new URL(inject('databaseUrl'))
        parsed.pathname = `/${name}`
        return parsed.toString()
    })()
    const folders: string[] = []
    /** A drizzle-kit folder with one migration newer than every applied one. */
    const migration = (tag: string, statement: string) => {
        const folder = mkdtempSync(join(tmpdir(), 'migrations-'))
        folders.push(folder)
        mkdirSync(join(folder, 'meta'))
        writeFileSync(
            join(folder, 'meta', '_journal.json'),
            JSON.stringify({
                version: '7',
                dialect: 'postgresql',
                entries: [
                    {
                        idx: 0,
                        version: '7',
                        when: Date.now(),
                        tag,
                        breakpoints: true,
                    },
                ],
            }),
        )
        writeFileSync(join(folder, `${tag}.sql`), statement)
        return folder
    }
    /** Another session reading payments in an open transaction: holds ACCESS SHARE. */
    const reader = async () => {
        const client = new pg.Client({
            connectionString: url,
        })
        await client.connect()
        await client.query('begin')
        await client.query('lock table payments in access share mode')
        return client
    }
    const columns = async () => {
        const client = new pg.Client({
            connectionString: url,
        })
        await client.connect()
        const { rows } = await client.query<{
            column_name: string
        }>(`select column_name from information_schema.columns where table_name = 'payments'`)
        await client.end()
        return rows.map(row => row.column_name)
    }

    beforeAll(async () => {
        const client = admin()
        await client.connect()
        await client.query(`create database ${name}`)
        await client.end()
        await runMigrations(url, migrationsFolder)
    })
    afterAll(async () => {
        const client = admin()
        await client.connect()
        await client.query(`drop database if exists ${name} with (force)`)
        await client.end()
        for (const folder of folders)
            rmSync(folder, {
                recursive: true,
                force: true,
            })
    })

    it("waits for a lock less than the app's budget, so queued queries still get through, then retries", async () => {
        const holder = await reader()
        const retries: number[] = []
        const migrated = runMigrations(
            url,
            migration('0100_extra', 'ALTER TABLE "payments" ADD COLUMN "extra" text;'),
            {
                retryDelayMs: () => 300,
                onRetry: attempt => retries.push(attempt),
            },
        )
        await new Promise(resolve => setTimeout(resolve, 200))

        // Queued behind the waiting ALTER, with the app's 2 s lock budget.
        const app = new pg.Client({
            connectionString: url,
            lock_timeout: 2_000,
        })
        await app.connect()
        const started = performance.now()
        await expect(app.query('select count(*) from payments')).resolves.toBeDefined()
        expect(elapsedSince(started)).toBeLessThan(1_500)
        await app.end()

        await holder.query('commit')
        await holder.end()
        await migrated
        expect(retries.length).toBeGreaterThanOrEqual(1)
        expect(await columns()).toContain('extra')
    })

    it('gives up after the last attempt and rolls the migration back', async () => {
        const holder = await reader()
        try {
            const failure = await runMigrations(
                url,
                migration('0101_blocked', 'ALTER TABLE "payments" ADD COLUMN "blocked" text;'),
                {
                    attempts: 2,
                    retryDelayMs: () => 100,
                },
            ).then(
                () => undefined,
                (error: unknown) => error,
            )
            expect(databaseFailure(failure)).toBe('lock_timeout')
        } finally {
            await holder.query('commit')
            await holder.end()
        }
        expect(await columns()).not.toContain('blocked')
    })
})
