Source: https://vitest.dev/llms.txt (official, condensed) + https://vitest.dev/guide/learn/writing-tests-with-ai.md (official guidance for AI agents, condensed); pages: https://vitest.dev/guide/projects.md, https://vitest.dev/config/globalsetup.md, https://vitest.dev/guide/recipes/wait-for.md; README unplugin-swc. The API was checked against the installed vitest 5.0.5 and unplugin-swc 2.0.0.

# Vitest 5

- Run tests only without watch: `vitest run`, with `--project unit` or `--project integration` when needed. The agent never calls `vitest` without `run`.
- Projects are described in `test.projects` of the root `vitest.config.ts`:
  - `unit`: `src/**/*.test.ts`, no network, DB or containers;
  - `integration`: `test/**/*.test.ts`, with a `globalSetup` on Testcontainers.
    In Vitest 5 inline projects inherit the root config (`extends: true` by default), so keep the plugins in the root.
- `plugins: [swc.vite()]` (`import swc from 'unplugin-swc'`) is required. The built-in transform doesn't emit decorator metadata, and without it Nest DI can't resolve dependencies in tests. SWC takes the decorator flags from `tsconfig.json`.
- Pass data from globalSetup only through `project.provide('pgUrl', url)` and `inject('pgUrl')` from `vitest`. Typing: `declare module 'vitest' { interface ProvidedContext { pgUrl: string } }`. Pass serializable values (URL strings), not client objects. globalSetup runs separately from the workers, and its globals are not visible to tests.
- Imports are explicit: `import { describe, it, expect, vi } from 'vitest'` (don't enable globals). Don't use `jest.*`.
- Mocks:
  - `vi.fn()`, `vi.spyOn()`, `vi.mock(import('./x.js'))` (the form with `import()` is type-safe), and `restoreMocks: true` in the config;
  - in integration tests, don't mock what they verify: the DB and the broker are real there.
- Wait for asynchronous conditions with `await expect.poll(() => fn(), { timeout, interval }).toBe(x)` or `vi.waitFor(...)`. No sleeps on `setTimeout` and no hand-written loops. For time-dependent logic, use `vi.useFakeTimers()`.
- A Nest application in a test:
  - `Test.createTestingModule({ imports: [AppModule] })`, overrides with `.overrideProvider(T).useValue(...)`, then `await app.init()`;
  - `await app.close()` in `afterAll` is required, otherwise open pools remain and the runner doesn't exit.
- Integration tests share the same containers. Each test creates its own data (unique ids, keys, queues) and doesn't depend on run order. A global DB reset is acceptable only with `fileParallelism: false` in the `integration` project.
- Assertions check behavior: `toEqual`, `toMatchObject`, `rejects.toThrow(AppError)`. Not `toBeDefined()` and not the order of internal calls. Cover errors and edge cases, not only the happy path.
- Test names are short and describe behavior, for example `returns 404 for unknown id`. Always run a generated test before committing.
