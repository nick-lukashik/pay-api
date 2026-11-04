Source: https://github.com/redis/agent-skills (official Redis agent skills: redis-core, redis-connections, redis-security; condensed) + https://redis.io/docs/latest/develop/clients/nodejs/produsage/ (official docs, summarized). The API was checked against the installed redis 6.3.1 (@redis/client 6.3.1).

# Redis 8 + node-redis (`redis` 6.x)

## Client

- One long-lived client per process: `createClient({ url, socket: { connectTimeout, reconnectStrategy } })`, as a provider by token. Don't create a connection per request. node-redis multiplexes a single connection and pipelines the commands of one tick by itself.
- `client.on('error', ...)` is required: without a listener, a connection error crashes the process. At startup, `await client.connect()`; at shutdown, `await client.close()`. `quit()` and `disconnect()` are deprecated; `destroy()` is used for shutdown escalation and to discard a connection whose commands exceeded the reply budget.
- Run blocking commands and Pub/Sub on a separate client, `client.duplicate()`, not on the shared one.
- `disableOfflineQueue: true` is recommended: when the connection drops, commands don't pile up and aren't resent after reconnecting, otherwise a non-idempotent `INCR` may be applied twice.
- Command budget (500 ms, service contract): in node-redis 6.3 both `commandOptions.timeout` (default 5000 ms) and `withAbortSignal(...)` only cover the time before a command is written (the listener is removed in `commandsToWrite()`), not the wait for its reply, so a paused or hung server is not bounded by them. Wrap every command in `bounded(...)` (`src/common/redis/redis.client.ts`), which races the reply and destroys a timed-out connection, rejecting pending commands before reconnecting without replay. Pass the client as its first argument. The queue is capped at 256 commands. A 5 s socket timeout bounds stalled handshakes; 2 s pings keep idle connections alive. `socket.socketTimeout` is an idle timeout of the socket, not a command timeout. Test it with `CLIENT PAUSE <ms> ALL` (`DEBUG SLEEP` is disabled by default since Redis 7).
- Redis is degradable: reconnect forever (`reconnectStrategy` always returns a delay, also before the first connection), wait a bounded time at startup, never fail readiness. `close()` waits for pending replies: on shutdown race it with a timer and `destroy()` after.

## Keys

- Keys are lowercase, short, with segments separated by colons: `<service>:<entity>:<id>[:<attr>]`. The service prefix is required because the instance is shared. Note that the `keyPrefix` option does not add the prefix to `SCAN MATCH` or to Pub/Sub channels.
- Don't use `KEYS`, `FLUSHALL` and `FLUSHDB` in code. Iterate keys with `scanIterator({ MATCH, COUNT })`, which returns batches of keys. Read large collections with `HSCAN`/`SSCAN`, not `HGETALL`/`SMEMBERS`.

## Cache

- Every cache key has a TTL: `set(key, value, { expiration: { type: 'EX', value: sec } })`. The old `{ EX }` and `{ NX }` options are deprecated; the write condition is now set with `condition: 'NX'`.
- List caches are built on versioned keys: `<svc>:<entity>:list:v<ver>:<hash(query)>`. Invalidate with `INCR <svc>:<entity>:list:ver`, not by deleting by pattern.
- The cache is not the source of truth. Validate values from Redis with a Zod schema. If Redis is down or the value didn't parse, read from the DB and write a warn to the log (at most one per interval during an outage, a metric counts each) instead of responding with a 500. A failed invalidation (`INCR` of the version) is retried, and until it lands that namespace is read from the DB: otherwise pages that miss a write made during the outage are served until their TTL.
- The rate limiter fails open when Redis is down or slow: allow the request, log, count (`rate_limit_fail_open_total`).
- Send independent commands as a batch with `multi().execAsPipeline()`. If you need atomicity, use `multi().exec()` or Lua.

## Lua (rate-limit storage for @nestjs/throttler)

- Describe the script with `defineScript({ NUMBER_OF_KEYS, SCRIPT, parseCommand(parser, ...) { parser.pushKey(key); parser.push(arg) }, transformReply })` and register it in `createClient({ scripts })`. The client handles EVALSHA with a fallback itself.
- Pass all keys through `pushKey` (`KEYS[]`), don't build them inside the script. Arguments are strings.
- `ThrottlerStorage.increment(key, ttl, limit, blockDuration, throttlerName)`: `ttl` and `blockDuration` arrive in milliseconds, while `timeToExpire` and `timeToBlockExpire` are returned in seconds, like the built-in storage (`Math.ceil`). The counter, PEXPIRE and the block are done atomically in one script.

## Security

- In prod the service has its own ACL user with minimal permissions: keys only under its own prefix, no `@dangerous`. TLS is required, there is no public access. The password comes from a secret, not from a config default.
