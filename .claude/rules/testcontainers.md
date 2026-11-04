Source: official docs (summarized): https://node.testcontainers.org/, https://node.testcontainers.org/features/containers/, https://node.testcontainers.org/features/wait-strategies/, https://node.testcontainers.org/modules/postgresql/, https://node.testcontainers.org/modules/redis/, https://node.testcontainers.org/modules/rabbitmq/, https://node.testcontainers.org/configuration/. The general principles come from the official https://github.com/testcontainers/claude-skills, but the skill there is only for Go and .NET, and there is none for Node. The API was checked against the installed testcontainers 12.2.1 and @testcontainers/{postgresql,redis,rabbitmq} 12.2.1.

# Testcontainers for Node 12

- Use only the ready-made modules: `PostgreSqlContainer`, `RedisContainer`, `RabbitMQContainer`; they already have the right wait strategies. Use `GenericContainer` only if there is no module, and then with `withWaitStrategy(Wait.forListeningPorts())` or `Wait.forLogMessage(...)`. Don't use sleeps.
- Specify the image explicitly and pin it to the same major (better, minor) version as in prod, for example `postgres:18-alpine`, `redis:8-alpine`, `rabbitmq:4.4-alpine`. Don't use the `latest` tag.
- Containers start once in the `integration` project's `globalSetup`, in parallel with `Promise.all`, and stop in teardown (`await container.stop()`). Don't start them in `beforeEach` or per file.
- Exception: a failure test that stops and starts a dependency gets its own container in its file (`test/containers.ts`), also in CI where the shared ones are service containers. Bind a fixed free host port below the ephemeral range (`withExposedPorts({ container, host })`): Docker keeps it across stop and start, so the app's URL stays valid. Stop and start through `getContainerRuntimeClient()` (`client.container.stop/start`); `restart()` has no down window.
- Take addresses only from the container itself:
  - Postgres: `getConnectionUri()`;
  - Redis: `getConnectionUrl()`;
  - RabbitMQ: `getAmqpUrl()`;
  - anything else: `getHost()` + `getMappedPort(port)`.
    No `localhost:5432` and no fixed host ports.
- Pass URL strings to the tests through `project.provide()`. The tests or the application create the clients.
- Postgres:
  - migrations are applied once in globalSetup with the same code as in prod (`migrate()` from `drizzle-orm/node-postgres/migrator`);
  - for a fast reset, take a `snapshot()` after the migrations and call `restoreSnapshot()` later;
  - close all connections before `snapshot()`, because it does `CREATE DATABASE … TEMPLATE`;
  - `restoreSnapshot()` kills active connections (`DROP DATABASE … WITH (FORCE)`), so recreate the application's pools after it.
- RabbitMQ: the application itself declares the topology (the same `setup`). By hand, a test creates only its own test queues, and their names are unique.
- Don't disable Ryuk (automatic cleanup of forgotten containers) without a reason. Set `TESTCONTAINERS_RYUK_DISABLED=true` only where Ryuk is impossible, and then teardown is mandatory.
- `withReuse()` is only for speeding up local development. Not in CI and not where tests change shared data.
- If startup has problems, enable `DEBUG=testcontainers*`. A reachable Docker daemon is required (`DOCKER_HOST` for a non-standard socket).
