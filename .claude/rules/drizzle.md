Source: https://orm.drizzle.team/llms.txt (official, condensed); pages: https://orm.drizzle.team/docs/sql-schema-declaration, https://orm.drizzle.team/docs/connect-overview, https://orm.drizzle.team/docs/transactions, https://orm.drizzle.team/docs/migrations, https://orm.drizzle.team/docs/drizzle-kit-generate, https://orm.drizzle.team/docs/kit-custom-migrations. The API was checked against the installed drizzle-orm 0.45.4, drizzle-kit 0.31.11, pg 8.23.1.

# Drizzle ORM + drizzle-kit (PostgreSQL 18, node-postgres)

## Versions

- Installed: drizzle-orm 0.45 and drizzle-kit 0.31. The site and its llms.txt already describe Drizzle v1 in places: `defineRelations`, RQB v2, the new migrations folder structure. None of that exists in our versions: relations are declared with `relations()`, and the driver is imported from `drizzle-orm/node-postgres`.

## Connection

- One `pg.Pool` per process (token `PG_POOL`) and Drizzle on top of it (token `DB`): `drizzle({ client: pool, schema })`. Write column names explicitly (`text('created_at')`). Don't use the `casing` option.
- Set `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` and `application_name` on the Pool explicitly. `pool.on('error', ...)` is required: without it, an error on an idle client crashes the process. On shutdown, call `await pool.end()`.
- Time budgets (service contract, `DATABASE_TIMEOUTS` in `src/common/database/database.ts`): `statement_timeout` 5 s, `lock_timeout` 2 s, `idle_in_transaction_session_timeout` 10 s as Pool options; pg 8.23 sends them as startup parameters of every connection (check with `current_setting(...)`). `connectionTimeoutMillis` 2 s bounds both connecting and waiting for a free client when the pool is full ("timeout exceeded when trying to connect"). The pool wraps queries with a 6 s reply deadline and closes a stuck client using `end()`; pipelining is explicitly disabled so an active query forces socket closure. This also applies to checked-out transaction clients. Don't use pg's client-side `query_timeout`: it returns an error but leaves the query running on the connection. The `ErrorFilter` maps SQLSTATE `55P03` (lock), `57014` (statement), the pool timeout and lost connections to 503 `UNAVAILABLE` (`databaseFailure()`).

## Schema

- Tables are exported from a single module, `src/db/schema.ts` (the shared outbox/inbox are re-exported from `src/common/messaging/outbox.schema.ts`). Both `drizzle()` and drizzle-kit use it.
- PK: ``uuid().primaryKey().default(sql`uuidv7()`)`` (the function is built into PG 18). Don't use `defaultRandom()` (that is v4, `gen_random_uuid()`) or `serial`.
- Time is `timestamp({ withTimezone: true })`. For `updatedAt` there is `.$onUpdate(() => new Date())`, but it fires only on updates made through Drizzle.
- Declare indexes and uniqueness in the schema (`index()`, `uniqueIndex()`, `unique()`), not by hand in SQL, otherwise the next `generate` will "lose" them.
- Take types from `typeof table.$inferSelect` and `$inferInsert`. Don't duplicate them as interfaces.

## Queries and transactions

- Write queries with the query builder or with `sql\`...\``and parameters.`sql.raw()` never receives user input.
- Inside `db.transaction(async (tx) => ...)` all queries go through `tx`: a query made through `db` runs on a different connection, outside the transaction. To roll back, throw an exception or call `tx.rollback()`.
- Outbox: the event is written in the same transaction as the business change. The relay takes a batch with a single `update … where event_id in (select … for update skip locked)` (`src/common/messaging/outbox.ts`).
- Inbox and idempotency: `insert(inbox).values(...).onConflictDoNothing({ target: ... }).returning()`. An empty result means a duplicate.
- `update` and `delete` always have `.where()` (the Biome rules `noDrizzle*WithoutWhere` check this).

## Migrations

- Create migrations only with `drizzle-kit generate --name=<what_it_does>`. Commit the SQL and the `meta/` folder together. Read the generated SQL: a rename may have turned into drop+add. `pnpm exec drizzle-kit check` verifies that the migrations folder is consistent.
- Create manual SQL and data migrations with `drizzle-kit generate --custom --name=...`. Don't edit applied migrations. `drizzle-kit push` is allowed only on a throwaway local DB.
- Apply them with `migrate(db, { migrationsFolder })` from `drizzle-orm/node-postgres/migrator` in `dist/db/migrate.js` (Argo CD Sync-hook Job), not at application startup. The folder with `.sql` files must end up in the image: tsc doesn't copy it.
- While the migration Job runs, the old version of the code is already running on the new schema. So migrations are backward compatible (expand → deploy → contract): don't drop or rename columns in the same release as the code.
- The pg-boss tables (schema `pgboss`) are not described in the Drizzle schema.
