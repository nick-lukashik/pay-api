import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate` compares the schema with drizzle/meta and writes SQL; no database needed.
export default defineConfig({
    dialect: 'postgresql',
    schema: './src/db/schema.ts',
    out: './drizzle',
    strict: true,
    verbose: true,
})
