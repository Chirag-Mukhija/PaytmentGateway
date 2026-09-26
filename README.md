# Payment Gateway

A learning project: a payment gateway built to understand the hard parts of
backend engineering (idempotency, state machines, the dual-write problem,
reliable webhooks, reconciliation) rather than to wrap an API.

## Getting started — one command

Requires Docker (Docker Desktop on Mac/Windows).

```bash
docker compose up --build
```

That starts seven services: Nginx on **http://localhost** (the only API
entry point), the gateway, a background worker, Postgres, Redis, a fake
bank, and a merchant-mock that receives webhooks on
**http://localhost:4000/webhooks**.

On first start, Postgres loads `db/schema.sql` and `db/seed.sql`, which
creates two merchants with fixed, **dev-only** credentials:

| Merchant | API key | Webhook secret |
|---|---|---|
| Test Merchant | `dev_test_key_merchant_1` | `dev_webhook_secret_merchant_1` |
| Second Merchant | `dev_test_key_merchant_2` | `dev_webhook_secret_merchant_2` |

Try it:

```bash
# create a payment
curl -s -X POST localhost/payments \
  -H 'x-api-key: dev_test_key_merchant_1' -H 'Content-Type: application/json' \
  -d '{"idempotency_key": "order_1", "amount": 499.50}'

# move it through the state machine (calls the fake bank)
curl -s -X POST localhost/payments/<id>/process -H 'x-api-key: dev_test_key_merchant_1'

# read it back (events, webhook delivery status, X-Cache header)
curl -si localhost/payments/<id> -H 'x-api-key: dev_test_key_merchant_1'

# what the merchant received
curl -s localhost:4000/webhooks

# system health and metrics
curl -s localhost/health
curl -s localhost/metrics -H 'x-admin-token: dev-admin-token'
```

Run the end-to-end checks against the stack:

```bash
GATEWAY_URL=http://localhost API_KEY=dev_test_key_merchant_1 ADMIN_TOKEN=dev-admin-token npm run smoke
```

Useful knobs (environment variables read by `docker-compose.yml`):

```bash
BANK_BEHAVIOR=always_timeout docker compose up -d fake-bank   # force PENDING
MERCHANT_FAIL_RATE=1 docker compose up -d merchant-mock       # force webhook retries
docker compose up -d --scale gateway=3                        # horizontal scale behind Nginx
```

`docker compose down` keeps all data (Postgres, Redis, the bank's ledger
live in named volumes). `docker compose down -v` wipes it and the next `up`
re-runs the schema and seed.

## Running without Docker

Needs Node 22, Postgres 16 and Redis 7 running locally.

```bash
npm install && (cd fake-bank && npm install)
createdb payments && psql -d payments -f db/schema.sql
cp .env.example .env            # then edit DATABASE_URL if needed
# insert a merchant (see db/seed.sql), then in separate terminals:
npm run merchant-mock
npm run fake-bank
npm start
npm run worker
```

For an existing database created before a later phase, run the numbered
files in `db/migrations/` in order. Each one is safe to re-run.

## Project documents

- `PROGRESS.md` — where the project stands, how each phase was verified.
- `DECISIONS.md` — every major design decision, the alternatives
  considered, and the tradeoff accepted.
- `phaseN_theory_reference.docx` — study notes for each phase.
- `paymentGatewayPlan.pdf` — the original six-phase plan.
