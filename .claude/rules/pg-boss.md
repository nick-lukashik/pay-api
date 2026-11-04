Source: official docs (summarized): https://pgboss.io/api/constructor, https://pgboss.io/api/queues, https://pgboss.io/api/workers, https://pgboss.io/api/adapters, https://pgboss.io/api/ops. AGENTS.md in the timgit/pg-boss repository is written for contributors to the library, not for its users. The API was checked against the installed pg-boss 12.38.0 (dist/types.d.ts).

# pg-boss 12

- Imports are named: `import { PgBoss, fromDrizzle } from 'pg-boss'` (the package is ESM, there is no default export).
- One instance per process: `new PgBoss({ connectionString, schema: 'pgboss', application_name, max })`. pg-boss has its own pool; its `max` must be greater than the sum of the workers' `localConcurrency`.
- `boss.on('error', ...)` is required: an EventEmitter without an `error` listener crashes the process. Log `warning` too.
- Call `await boss.start()` at bootstrap. It installs and migrates its own `pgboss` schema (these are not Drizzle migrations), so we don't describe the pg-boss tables in the Drizzle schema.
- Create the queue explicitly before the first `send()`, otherwise you get a reject "Queue … does not exist". Order: the DLQ first, then the queue with `deadLetter`. `createQueue` is idempotent but doesn't change the options of an existing queue; to change them you need `updateQueue()`.
- Set queue options explicitly: `retryLimit` (default 2), `retryDelay`, `retryBackoff: true`, `retryDelayMax`, `expireInSeconds` (default 15 minutes), `deadLetter`. Choose `policy` (`standard`, `singleton`, `stately`, ...) to fit the job.
- Enqueue the job together with the business change: `db.transaction(async (tx) => { ...; await boss.send(name, data, { db: fromDrizzle(tx, sql) }) })`, where `sql` comes from `drizzle-orm`. Rolling back the transaction rolls back the job too. If you call `send()` without `db` inside a transaction, the job is sent even on rollback.
- Keep the payload small and serializable: ids and parameters, not whole entities. Deduplicate with `singletonKey` or `id`.
- Worker: `boss.work(name, { batchSize, localConcurrency }, async (jobs) => ...)`, the handler receives an array of jobs. An exception marks the whole batch failed, and retries follow according to the queue settings; a normal return completes the batch as completed. For a per-job result, use the `perJobResults: true` option.
- The handler must be idempotent: delivery is at-least-once, and an `expireInSeconds` timeout or a pod restart causes a repeat. The handler respects `job.signal` (abort on expiry) and validates `job.data` with a Zod schema. Don't retry invalid data: with `perJobResults` return `status: 'deadletter'`.
- Log job events through the Nest `Logger` with `jobId` in the log object: `logger.log({ jobId: job.id }, "...")`.
- Cron: `boss.schedule(name, cron, data, { tz })`. The schedule is stored in the DB, so multiple replicas don't interfere with it.
- Shutdown: `await boss.stop({ graceful: true, timeout })` in `beforeApplicationShutdown`, before the Drizzle Pool closes. `timeout` (default 30000 ms) is less than the pod's `terminationGracePeriodSeconds`. Note that `stop()` won't wait for a handler that ignores `signal`.
