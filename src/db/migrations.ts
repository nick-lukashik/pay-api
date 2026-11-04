import { fileURLToPath } from 'node:url'
import { type MigrationOptions, runMigrations } from '../common/database/database.js'

/** drizzle/ at the project root, from src/db or dist/db alike. */
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Applies this service's SQL migrations. */
export async function migrateDatabase(url: string, options?: MigrationOptions) {
    await runMigrations(url, migrationsFolder, options)
}
