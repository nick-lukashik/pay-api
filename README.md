# pay-api

Payments of the nick-lukashik platform: a catalog of coin packs, checkout through a payment provider, provider webhooks. A confirmed payment becomes `pay.payment.succeeded.v1`, and wallet-api credits the pack.

Built from [`nest-example`](https://github.com/nick-lukashik/nest-example): Postgres, RabbitMQ outbox. Design: [`.github/docs/identity.md`](https://github.com/nick-lukashik/.github/blob/master/docs/identity.md). The provider contract is ported from the previous platform's `payments-backend`.

## Rules of money

- **The server decides.** The browser picks a product and a currency. The server decides the user, the coins, the amount and the currency, from `src/catalog/catalog.ts`, and keeps them as an immutable snapshot on the payment. The return URL proves nothing.
- **Only an authenticated provider fact confirms a payment.** The credential is checked before the payload is read. The amount and the currency must match the snapshot, otherwise the outcome is `mismatch` and nothing changes.
- **Paid once.** A success is applied under the payment's row lock. A later failure never undoes it, and every webhook is recorded once by its dedupe key (`webhook_events`, only a hash of the payload).
- **Checkout is idempotent per user.** `Idempotency-Key` is required: the same key and request return the same payment, another request gets 409.

## API

| Route                                                                     | Who                              | What                                                        |
| ------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/catalog`                                                     | anyone                           | The coin packs and their prices in RUB, USD and EUR         |
| `POST /api/v1/me/checkout` `{ productKey, currency }` + `Idempotency-Key` | access token                     | `{ id, status: pending, checkoutUrl, ... }`                 |
| `GET /api/v1/me/payments`, `GET /api/v1/me/payments/:id`                  | access token                     | The caller's payments                                       |
| `POST /api/v1/me/payments/:id/fake-complete`                              | access token, fake provider only | Confirms without money (local runs, stage)                  |
| `POST /webhooks/lava`                                                     | Lava, `X-Api-Key`                | The only public route, `hooks.nick-lukashik.com/webhooks/*` |

## Providers (`PAY_PROVIDER`)

- **`fake`.** The checkout URL is id-web's `/payments/fake/<id>`. It refuses to start with `NODE_ENV=production`, unless `PAY_ALLOW_FAKE=true` (stage).
- **`lava`.** lava.top: `POST /api/v3/invoice` with the offer of each pack (`LAVA_OFFER_COINS_*`), and webhooks authenticated by `LAVA_WEBHOOK_SECRET`. Not yet checked against a merchant account. The offers, the sandbox and the status values are assumptions from Lava's OpenAPI 1.22.0, to verify before real money.

Not yet:
- expiring payments that stay pending;
- refunds and chargebacks;
- reconciliation with the provider's invoices.

## Commands

```bash
pnpm install
pnpm infra:up      # Postgres, RabbitMQ (ports 5444, 5684)
pnpm env:local
pnpm db:migrate
pnpm dev           # http://localhost:4400
pnpm verify
```
