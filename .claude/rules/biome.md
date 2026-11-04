Source: official docs (summarized): https://biomejs.dev/reference/configuration/, https://biomejs.dev/reference/cli/, https://biomejs.dev/linter/domains/, https://biomejs.dev/linter/rules/use-import-type/, https://biomejs.dev/linter/rules/no-drizzle-update-without-where/, https://biomejs.dev/guides/upgrade-to-biome-v2/. There are no official agent rules or llms.txt: the skills in biomejs/biome are written for developing Biome itself. Rules and options were checked against the installed @biomejs/biome 2.6.4 (`biome explain`, configuration_schema.json).

# Biome 2

- Biome is the only formatter and linter. Don't add ESLint or Prettier. The config is `biome.json` with `$schema` pointing at the installed version.
- Commands:
  - locally: `biome check --write` (formatting, safe linter fixes and import sorting);
  - in CI: `biome ci`, which writes nothing;
  - `--unsafe`: only after reviewing the diff;
  - rule description: `biome explain <rule>`;
  - run on changed files only: `--changed` or `--staged`.
- After editing code, the agent runs `biome check --write` on the changed files and leaves no diagnostics.
- v2 syntax:
  - `files.includes` with negations such as `"!dist"`;
  - `vcs: { enabled: true, clientKind: "git", useIgnoreFile: true }`;
  - import sorting: `assist.actions.source.organizeImports`;
  - after upgrading Biome: `biome migrate --write`.
- Nest specifics:
  - `javascript.parser.unsafeParameterDecoratorsEnabled: true` is required, otherwise parameter decorators (`@Body()`, `@Inject()`) don't parse;
  - `style/useImportType: "off"` is off on purpose. Biome can't see that an import "used as a type" is needed at runtime for `emitDecoratorMetadata`, and the rule's docs advise the same. Don't enable it and don't switch provider imports to `import type`.
- Domains:
  - `drizzle` provides `noDrizzleUpdateWithoutWhere` and `noDrizzleDeleteWithoutWhere`. List the object names in the `drizzleObjectName` option, for example `["db", "tx"]`;
  - `test`: rules for tests;
  - enable nursery rules (for example `noFloatingPromises` from the `types` domain) only deliberately: they are unstable.
- Suppress only at the specific spot: `// biome-ignore lint/<group>/<rule>: <reason>`. The reason is required. Don't disable a rule globally for one place; for particular paths use `overrides` with `includes`.
- Don't work around the recommended rules `noExplicitAny` and `noNonNullAssertion`: use `unknown` with narrowing (Zod) instead of `any`, and an explicit check instead of `!`.
