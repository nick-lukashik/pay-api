# AGENTS.md

pay-api: catalog, checkout, providers (`fake`, `lava`), webhooks. Built from nest-example; `src/common/` stays identical to it, except the error codes (as in wallet-api). Human docs: `README.md`.

## Rules

- Amounts and products come from `src/catalog/catalog.ts`, never from the client. A payment's snapshot (`coins`, `amount`, `currency`) is never updated.
- A provider fact reaches a payment only through `PaymentsService.apply`, inside the transaction that recorded the webhook or that wrote the provider id (a webhook that came first waits as `unmatched`). A success is final. A success a webhook leaves incomplete is confirmed by the provider's record; until then the answer is 503 and nothing is recorded.
- Checkout moves a payment `created` → `creating` → `pending` or `failed` (`checkout_lost`) under the lease of `claimCheckout`. An answer is written only while its claim holds (`recordCheckout`); a late one only gives a lost checkout its URL.
- `ReconciliationService` only sets `reconciled_at` and sends the event again; it never changes a status. The event id of `pay.payment.succeeded.v1` is the payment id, so a copy stays the same event for every consumer.
- Metrics of money: `payment_webhooks_total`, `payment_reconciliation_total`, `payments_unreconciled`.
- Provider formats stay inside `src/providers/`. Adding a provider means a new `PaymentProvider` and its webhook tests: bad credential, duplicate, mismatch, unknown.
- `pnpm verify` must be green before you hand work over.
