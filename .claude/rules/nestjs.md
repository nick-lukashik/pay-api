Source: https://docs.nestjs.com/llms.txt + https://docs.nestjs.com/llms-full.txt (official, condensed); chapters: application/validation.md, openapi/introduction.md, application/configuration.md, reliability/terminus.md, security/rate-limiting.md, fundamentals/lifecycle-events.md. The API was checked against the installed @nestjs/* 12.3.2, config 12.0.1, terminus 12.1.0, throttler 6.7.1, swagger 12.0.5.

# NestJS 12 (+ config, terminus, throttler, swagger)

## ESM and DI

- ESM (`"type": "module"`, `module: nodenext`), built with plain `tsc`, no Nest CLI. Relative imports are written with the `.js` suffix.
- DI takes constructor parameter types from `emitDecoratorMetadata`, so providers, `ConfigService`, `PinoLogger` and other injectable classes are imported as values. `import type` is allowed only for pure types. Biome `useImportType` is off on purpose; there is nothing to "fix" here.
- Dependencies that are not classes (Pool, Drizzle db, redis client, AMQP connection, PgBoss) are injected by a `Symbol` token with `@Inject(TOKEN)`.
- Open resources in a provider factory or in `onModuleInit`, and close them in `onApplicationShutdown`. pg-boss and consumers stop earlier, in `beforeApplicationShutdown`, while the Pool is still alive. `app.enableShutdownHooks()` is required (K8s sends SIGTERM).

## Validation (Standard Schema + Zod 4)

- The pipe is global: `app.useGlobalPipes(new StandardSchemaValidationPipe({ exceptionFactory }))`. `exceptionFactory` turns issues into an `AppError` with `details`. Don't use class-validator, nestjs-zod or `ValidationPipe`.
- Put the schema on the parameter: `@Body({ schema })`, `@Query({ schema })`, `@Param('id', { schema: z.uuid() })`. The parameter type is `z.output<typeof schema>`: with `transform: true` (the default) the handler receives the schema's result.
- The pipe validates only parameters that have a `schema`. It validates custom decorators only with `validateCustomDecorators: true`.
- Optionally, the response schema can be used as a field allowlist: `StandardSchemaSerializerInterceptor` + `@SerializeOptions({ schema })`.

## Errors

- Throw business errors as `throw new AppError(...)` from `src/common/http`. The global filter turns any exception into `{ code, message, details?, requestId }`: `HttpException`, `ThrottlerException` (429), a body-parser refusal (413 `PAYLOAD_TOO_LARGE`), a database over its budget or down (503 `UNAVAILABLE`), and an unknown one becomes a 500 with no stack in the response.
- Body limit: `app.useBodyParser('json' | 'urlencoded', { limit })` before `init()`; Nest then skips its own parsers (100 kb). The request budget is a global interceptor with rxjs `timeout({ first })` that throws `AppError('TIMEOUT')` (504); guards run before interceptors, so their own calls need their own budget.

## OpenAPI (@nestjs/swagger 12)

- Body, query and params get into the document automatically from the decorators' `schema`. Describe responses with `@ApiOkResponse({ standardSchema })` and `@ApiCreatedResponse({ standardSchema })`, and errors with a shared error schema.
- Zod 4 is converted natively through `~standard.jsonSchema` (target `openapi-3.0`: the input schema for requests, the output schema for responses). `standardSchemaConverter` is not needed.
- Set the component name with `.meta({ id: 'ItemDto' })`. Ids must be unique: a duplicate crashes document generation.
- Response schemas must not contain `.transform()`, `z.date()` or `z.bigint()`: JSON Schema can't express them, and generation fails. Pass dates as `z.iso.datetime()`.

## Config (@nestjs/config 12)

- `ConfigModule.forRoot({ isGlobal: true, cache: true, validationSchema: envSchema, load: [...] })`. Pass the Zod env schema here; if validation fails, the application doesn't start. Secrets never have `.default()`.
- Setting groups use `registerAs('db', ...)`, and injection is `@Inject(dbConfig.KEY) cfg: ConfigType<typeof dbConfig>`. Factories don't parse `process.env` strings by hand. They take typed values from the Zod result.
- Read values from `ConfigService` with `getOrThrow()`, not `get()`, which silently returns `undefined`.

## Health (terminus 12)

- `liveness` doesn't check dependencies. `readiness` checks every dependency registered in `HealthRegistry` through `HealthIndicatorService.check(key).attempt(fn).withTimeout(ms)`; add `.cacheFor(ms)` for expensive checks. Only Postgres is `required` (service contract); Redis and RabbitMQ are degradable.
- An indicator must not throw an exception instead of `up()`/`down()`: you get a 500 instead of a 503. Wrap operations that can throw in `attempt()`. For a non-critical dependency, return `degraded()` (terminus 12): the response stays 200 with overall status `degraded`, and the state is visible in the body and in monitoring.
- `TerminusModule.forRoot({ gracefulShutdownTimeoutMs })` with a delay slightly longer than the readiness probe period: after SIGTERM the probe returns 503 `shutting_down`, and traffic has time to drain.

## Throttler 6

- `ThrottlerModule.forRootAsync(...)` in `AppModule`, and `ThrottlerGuard` is attached to specific routes: `@UseGuards(ThrottlerGuard)` (currently `POST /api/v1/notes`). Change a route's limit with `@Throttle({ default: { limit, ttl } })`. The storage is Redis (a custom `ThrottlerStorage`, see `redis.md`), not process memory.
- `ttl` and `blockDuration` are set in milliseconds (helpers `seconds()`, `minutes()`). If the guard becomes global (`APP_GUARD`), put `@SkipThrottle()` on health. Behind an ingress, enable `trust proxy`, otherwise all requests will be counted as coming from the proxy.
