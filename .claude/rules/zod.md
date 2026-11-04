Source: https://zod.dev/llms.txt (official, condensed); pages: https://zod.dev/api, https://zod.dev/v4/changelog, https://zod.dev/json-schema, https://zod.dev/error-customization, https://zod.dev/error-formatting. The API and the JSON Schema behavior were checked against the installed zod 4.6.7.

# Zod 4

- Import: `import { z } from 'zod'`. Write only against the v4 API and don't use deprecated features:
  - formats are top-level functions: `z.email()`, `z.uuid()` (for our ids, `z.uuidv7()`), `z.url()`, `z.iso.datetime()`, `z.iso.date()`. Not `z.string().email()`, `.uuid()`, `.datetime()`;
  - the error text is the `error` parameter (`z.string({ error: '...' })`, `.min(1, { error: '...' })`), not `message`;
  - objects: `z.strictObject()` and `z.looseObject()` instead of `.strict()` and `.passthrough()`; `A.extend(B.shape)` instead of `.merge()`; `z.enum()` instead of `z.nativeEnum()`;
  - error formatting: `z.treeifyError()`, `z.flattenError()`, `z.prettifyError()` instead of `err.format()` and `err.flatten()`.
- The schema is the single source of truth. Infer types with `z.infer`, `z.input`, `z.output`; don't create parallel interfaces. Contract schemas live in a module (`*.schema.ts`) and are reused in validation, OpenAPI and tests.
- `z.object()` silently drops extra keys. For input bodies where a typo in a field name is a client error, use `z.strictObject()`. A response schema works as an allowlist: don't return a whole DB row.
- Everything that comes from outside is parsed with a schema: HTTP (through `StandardSchemaValidationPipe`), RabbitMQ messages, pg-boss `job.data`, values from Redis, env. Outside HTTP use `safeParse` and handle `success: false` explicitly: an invalid message goes to the DLQ, not to a retry.
- String inputs (query, path, env): numbers use `z.coerce.number().int()`, flags use `z.stringbool()`. `z.coerce.boolean()` turns `"false"` into `true`.
- Env schema: a secret is `z.string().min(1)` with no `.default()`; a URL is `z.url()`; a port is `z.coerce.number().int().min(1).max(65535)`.
- OpenAPI: `.meta({ id: 'Name', description })` becomes the component `#/components/schemas/Name`. The id is unique within the document: a duplicate throws an error during conversion.
- Response schemas have no `.transform()`, `z.date()` or `z.bigint()`: JSON Schema can't express them, and generation fails. In input schemas transform is allowed, because the input side is what gets documented. Check the result manually with `z.toJSONSchema(schema, { target: 'openapi-3.0' })`.
- Custom checks are `.refine()` and `.superRefine()` with a clear `error`; set the path with `path` so the error points at a specific field.
