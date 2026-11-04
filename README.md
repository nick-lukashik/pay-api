# pay-api

Payments of the nick-lukashik platform: a catalog of coin packs, checkout through a payment provider, provider webhooks. A confirmed payment becomes `pay.payment.succeeded.v1`, and wallet-api credits the pack; a reconciliation job checks that it did.

Built from [`nest-example`](https://github.com/nick-lukashik/nest-example): Postgres, RabbitMQ outbox. Design: [`.github/docs/identity.md`](https://github.com/nick-lukashik/.github/blob/master/docs/identity.md). The provider contract is ported from the previous platform's `payments-backend`.

## Rules of money

- **The server decides.** The browser picks a product and a currency. The server decides the user, the coins, the amount and the currency, from `src/catalog/catalog.ts`, and keeps them as an immutable snapshot on the payment. The return URL proves nothing.
- **Only an authenticated provider fact confirms a payment.** The credential is checked before the payload is read. The amount and the currency must match the snapshot, otherwise the outcome is `mismatch` and nothing changes.
- **Paid once.** A success is applied under the payment's row lock. A later failure never undoes it, and every webhook is recorded once by its dedupe key (`webhook_events`: the verified fact, a hash of the payload, `received_at` and `applied_at`, never the payload itself). A webhook that came before its payment had the provider id is applied when the id is written.
- **A success the provider does not confirm yet is not an answer.** When a webhook leaves out the amount or the currency, the provider's own record decides. Until that record shows the money, the answer is 503 and nothing is recorded, only counted (`payment_webhooks_total{result="deferred"}`) and logged with the provider's payment id, so the provider's retry asks again.
- **Checkout is idempotent per user.** `Idempotency-Key` is required: the same key and request return the same payment, another request gets 409.
- **One provider checkout per payment.** One request at a time creates it, under a lease on the payment (`created` → `creating` → `pending`). Others wait for it until 8.5 s after they started, under the 10 s request budget, and only then answer `creating`. An attempt with an unknown outcome looks for its checkout before creating one. One found again without its URL becomes `failed` (`checkout_lost`), unless the late answer with that URL still arrives.
- **Every paid payment ends up in the ledger.** See [Reconciliation](#reconciliation).
- **A payment whose webhook never came is still noticed.** See [Provider sync](#provider-sync).

## API

| Route                                                                     | Who                                 | What                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/catalog`                                                     | anyone                              | The coin packs and their prices in RUB, USD and EUR                                                               |
| `POST /api/v1/me/checkout` `{ productKey, currency }` + `Idempotency-Key` | access token                        | `{ id, status, checkoutUrl, ... }`, see below                                                                     |
| `GET /api/v1/me/payments`, `GET /api/v1/me/payments/:id`                  | access token                        | The caller's payments                                                                                             |
| `POST /api/v1/me/payments/:id/fake-complete`                              | access token, fake provider only    | Confirms without money (local runs, stage)                                                                        |
| `POST /webhooks/:provider`                                                | the active provider, its credential | The only public route, `hooks.nick-lukashik.com/webhooks/*`; 404 unless `:provider` is the active provider's name |

What the status of a checkout answer means:

| `status`    | `checkoutUrl` | What to do                                                                        |
| ----------- | ------------- | --------------------------------------------------------------------------------- |
| `pending`   | the URL       | Go there                                                                          |
| `creating`  | null          | Another request with this key is still creating the checkout: retry with the key  |
| `failed`    | null          | Nobody can pay this checkout (`checkout_lost`, or the provider failed): a new key |
| `succeeded` | null          | Already paid                                                                      |

## Reconciliation

A paid payment that never reached the ledger would be paid without coins, so a job looks for it. Every minute, and when a pod starts, it takes the succeeded payments older than 5 minutes that are not reconciled yet and asks wallet-api which of their refs `pack:payment:<id>` the ledger has (`POST /api/v1/internal/refs`).

- **In the ledger:** the payment gets `reconciled_at` and is not looked at again.
- **Not in the ledger:** its `pay.payment.succeeded.v1` goes out again through the outbox, unless it is still on its way (not published yet, or published in the last 5 minutes). The event id is the payment id, so the inbox of every consumer sees the same event, and wallet-api also deduplicates by the ref.
- **wallet-api unavailable:** nothing changes, the next round tries again.

An advisory lock keeps a round to one pod at a time. Metrics: `payment_reconciliation_total{result="ok|republished|error"}` (`error` counts failed batches, the others payments) and `payments_unreconciled`, the payments past the 5 minutes without `reconciled_at`.

## Provider sync

A webhook can get lost, so the same job also asks the provider. After the ledger, each round takes up to 50 pending payments of the active provider with a provider id, from 10 minutes to 7 days old, those asked longest ago first, and calls `lookup` for each, outside any transaction. The lock keeps two pods from taking the same batch.

- **A fact** takes the path of a webhook: it is recorded once in `webhook_events` under `sync:<payment id>:<outcome>` and applied under the payment's row lock, with the same exact amount and currency checks. A webhook that comes later is a duplicate.
- **A mismatch** is recorded once, and the payment stays pending. Later rounds count it again, and a record corrected later does not pay it: someone has to look.
- **A success without the money** counts as `open`, as the record can lag. Nothing is recorded, and the next round asks again.
- **`open`, or no record at the provider:** nothing changes.
- **The provider cannot be asked:** nothing changes for that payment, the others go on, and a later round asks again.

Metrics: `payment_provider_sync_total{result="applied|open|missing|mismatch|error"}`, per lookup, and `payments_unconfirmed`, the payments in that window. Checkouts nobody paid stay in it, so watch its trend rather than its value.

## Providers (`PAY_PROVIDER`)

The core knows only `PaymentProvider` (`src/providers/provider.ts`). `PAY_PROVIDER` picks one adapter from the registry (`src/providers/registry.ts`), and the service stops at startup when that adapter's variables are invalid. The variables of the others are not read.

- **`fake`.** The checkout URL is id-web's `/payments/fake/<id>` (`ID_WEB_URL`). It refuses to start with `NODE_ENV=production`, unless `PAY_ALLOW_FAKE=true` (stage).
- **`lava`.** lava.top: `POST /api/v3/invoice` with the offer of each pack (`LAVA_OFFER_COINS_*`), and webhooks authenticated by `LAVA_WEBHOOK_SECRET`, retried by Lava 19 times over about 5 hours. Not yet checked against a merchant account. The offers, the sandbox and the status values are assumptions from Lava's OpenAPI 1.22.0, to verify before real money.

Compared with the provider's own record: the outcome, the amount and the currency of a pending payment with a provider id, from 10 minutes to 7 days after it was created, and of a webhook's success that leaves out the money.

Not yet:
- comparing a pending payment older than 7 days, and expiring it: it stays pending;
- comparing a `created` or `creating` payment: its checkout is looked for only when the buyer retries;
- comparing a `failed` payment: a later success reaches it only by webhook;
- comparing a `succeeded` payment: refunds and chargebacks are not handled;
- comparing payments of a provider that is no longer the active one;
- comparing the provider's reports and payouts with ours.

## Adding a provider

1. **An adapter file**, `src/providers/<name>.provider.ts`: a `PaymentProvider` whose `name` is `<name>`, and its env block, a Zod object of its own variables. Anything of the provider stays in this file, such as its offers per product of the catalog.
2. **One line in the registry**, `src/providers/registry.ts`.
3. **The env block in `.env.example`.**
4. **The contract suite**, `test/provider-contract.ts`, run for the adapter from `test/provider-contract.int.test.ts` against a stand-in of the provider. It pins what the service relies on.

Its webhooks then arrive at `POST /webhooks/<name>`, and nothing else in the core changes.

## Commands

```bash
pnpm install
pnpm infra:up      # Postgres, RabbitMQ (ports 5444, 5684)
pnpm env:local
pnpm db:migrate
pnpm dev           # http://localhost:4400
pnpm verify
```
