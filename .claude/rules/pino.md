Source: official docs (summarized): https://raw.githubusercontent.com/pinojs/pino/main/docs/api.md, https://raw.githubusercontent.com/pinojs/pino/main/docs/redaction.md, https://raw.githubusercontent.com/pinojs/pino/main/docs/help.md, https://github.com/pinojs/pino-http, https://github.com/iamolegga/nestjs-pino (README). There are no official agent rules or llms.txt for pino and nestjs-pino. The API was checked against the installed pino 10.4.0, pino-http 11.0.0, nestjs-pino 5.3.1.

# pino 10 + nestjs-pino 5

- Logs are JSON only, written to stdout through the default synchronous destination. Don't wire up `pino-pretty` or transports: the cluster collects the logs. Read them locally with `jq`.
- Setup:
  - `LoggerModule.forRootAsync({ inject: [...], useFactory: () => ({ pinoHttp: {...} }) })`;
  - `NestFactory.create(AppModule, { bufferLogs: true })` + `app.useLogger(app.get(Logger))`;
  - don't wire up `LoggerErrorInterceptor`: expected 4xx responses must not drag a stack into the log. `ErrorFilter` logs 5xx as `logger.error({ err }, ...)` inside the request, that is, with `requestId`.
- In classes, take `PinoLogger` via `@InjectPinoLogger(MyService.name)` or `Logger` from `@nestjs/common`. Don't use `console.*`.
- requestId:
  - `genReqId` accepts an incoming `x-request-id` if it is short and consists of `[\w-]`, otherwise it generates `randomUUID()`. The value is returned in the response header;
  - `quietReqLogger: true` + `customAttributeKeys: { reqId: 'requestId' }` give a `requestId` field in every request line, and the full `req` appears only in the completion line;
  - the same `requestId` goes into the error body and becomes the `correlationId` of events written by this request.
- Outside HTTP, correlation comes from `AsyncLocalStorage` in `src/common/context/request-context.ts`: the consumer runs the handler in `runWithContext(...)`, and the logger's `mixin` adds `correlationId` to every line. Do the same for your own background loops. `PinoLogger.runInContext`/`assign` from nestjs-pino also exist, but the project doesn't use them.
- Call style: `logger.info({ orderId }, 'order created')`. The object comes first, the message is constant, and data is not interpolated into the string. Log an error as `logger.error({ err }, '...')`.
- Levels:
  - `level` comes from config (`LOG_LEVEL`);
  - `customLogLevel`: 5xx → `error`, 4xx → `warn`, everything else → `info`;
  - `autoLogging.ignore` for `/health/*` and `/metrics`.
- Redact: `redact: { paths, censor: '[REDACTED]' }`, at minimum `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]` and fields with passwords, tokens and secrets.
  - Paths are constants set at initialization and are never taken from user input.
  - Explicit paths are better than `*` wildcards: wildcards are noticeably more expensive.
  - Don't log request and response bodies by default.
- Don't put secrets and personal data into messages or `bindings` at all. Redact is only a safety net.
- If an asynchronous destination or a transport appears, a flush is needed on exit: `app.enableShutdownHooks(undefined, { useProcessExit: true })`. This changes the exit code.
