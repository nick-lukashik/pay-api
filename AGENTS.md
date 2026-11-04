# AGENTS.md

pay-api: catalog, checkout, providers (`fake`, `lava`), webhooks. Built from nest-example; `src/common/` stays identical to it, except the error codes (as in wallet-api). Human docs: `README.md`.

## Rules

- Amounts and products come from `src/catalog/catalog.ts`, never from the client. A payment's snapshot (`coins`, `amount`, `currency`) is never updated.
- Only `PaymentsService.apply` changes a payment's status, inside the transaction that recorded the webhook. A success is final.
- Provider formats stay inside `src/providers/`. Adding a provider means a new `PaymentProvider` and its webhook tests: bad credential, duplicate, mismatch, unknown.
- `pnpm verify` must be green before you hand work over.
