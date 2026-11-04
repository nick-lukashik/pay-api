# AGENTS.md

pay-api: catalog, checkout, providers (`fake`, `lava`), webhooks. Built from nest-example; `src/common/` stays identical to it, except the error codes (as in wallet-api). Human docs: `README.md`.

## Rules

- Amounts and products come from `src/catalog/catalog.ts`, never from the client. The catalog knows only products; a provider's offers live in its adapter. A payment's snapshot (`coins`, `amount`, `currency`) is never updated.
- A provider fact reaches a payment only through `PaymentsService.apply`, inside the transaction that recorded the webhook (or the fact of `askProvider`, under `sync:<payment id>:<outcome>`) or that wrote the provider id (a webhook that came first waits as `unmatched`). A success is final. A success a webhook leaves incomplete is confirmed by the provider's record; until then the answer is 503 and nothing is recorded, only counted as `deferred`.
- Checkout moves a payment `created` → `creating` → `pending` or `failed` (`checkout_lost`) under the lease of `claimCheckout`. An answer is written only while its claim holds (`recordCheckout`); a late one only gives a lost checkout its URL.
- `ReconciliationService` only sets `reconciled_at` and `provider_checked_at` and sends the event again; it never changes a status, and calls the provider outside any transaction (`idle_in_transaction_session_timeout`). The event id of `pay.payment.succeeded.v1` is the payment id, so a copy stays the same event for every consumer.
- Metrics of money: `payment_webhooks_total`, `payment_reconciliation_total`, `payments_unreconciled`, `payment_provider_sync_total`, `payments_unconfirmed`.
- Provider formats, offers and variables stay inside the adapter's file in `src/providers/`. The core sees only `PaymentProvider`; the provider is chosen in `src/providers/registry.ts` and nowhere else, and only the selected adapter's env block is validated.
- `pnpm verify` must be green before you hand work over.

## Adding a provider

A new `src/providers/<name>.provider.ts` (the adapter, `name` equal to `<name>`, and its env block), one line in `src/providers/registry.ts`, its variables in `.env.example`, a row in the README, a run of the contract suite (`test/provider-contract.ts`) against a stand-in of the provider, and its webhook tests: bad credential, duplicate, mismatch, unknown. `POST /webhooks/:provider` answers 404 under any other name than the active provider's.
