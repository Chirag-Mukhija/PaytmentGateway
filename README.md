# Payment Gateway

## What this is

A payment gateway, built to understand the hard parts of backend
engineering rather than to wrap an API. A merchant creates a payment, the
gateway charges a (fake) bank, records every state change in an
append-only audit log, and tells the merchant what happened through signed,
retried webhooks. Most of the work is in how it stays correct when the bank
times out, the process crashes mid-payment, Redis goes down, the same
request arrives twice at the same instant, or the merchant's server is
offline. A daily reconciliation job catches whatever still slips through.
Every design choice is in [`DECISIONS.md`](DECISIONS.md) along with the
alternatives that were considered.

## Architecture

```
                 ┌──────────────────────────────────────────┐
  merchant ────► │ Nginx :80   per-IP limit · request id ·  │
  (HTTP)         │             JSON access log · LB         │
                 └───────────────────┬──────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ Gateway (Express, N instances, stateless)│
                 │  auth (cached) → rate limit → validate   │
                 │  POST /payments          idempotent create│
                 │  POST /payments/:id/process  state machine│
                 │  GET  /payments[/:id]    (terminal cached)│
                 │  /health  /metrics  /admin/reconciliation │
                 └──┬──────────────┬─────────────────┬──────┘
                    │              │                 │ charge / lookup
                    ▼              ▼                 ▼
             ┌────────────┐  ┌───────────┐   ┌──────────────┐
             │ PostgreSQL │  │   Redis   │   │  Fake bank   │
             │ payments   │  │ locks     │   │ random ok /  │
             │ events     │  │ limits    │   │ fail / hang  │
             │ outbox     │  │ cache     │   │ + ledger     │
             │ recon      │  │ BullMQ    │   └──────▲───────┘
             └─────▲──────┘  └─────▲─────┘          │
                   │               │                │ lookup, ledger
                 ┌─┴───────────────┴────────────────┴──────┐
                 │ Worker   webhook delivery (retry/backoff)│──► merchant-mock
                 │          PENDING resolution · outbox     │    (verifies
                 │          sweep · daily reconciliation    │     signatures)
                 └──────────────────────────────────────────┘
```

**Payment lifecycle:**
`INITIATED → PROCESSING → SUCCESS | FAILED | PENDING → (resolved) SUCCESS | FAILED`.
`PROCESSING` is committed *before* the bank is called; any answer that
isn't definitive (timeout, connection error) becomes `PENDING`, never
`FAILED`, and is resolved later by asking the bank, never by charging again.

## Getting started — one command

Requires Docker (Docker Desktop on Mac/Windows).

```bash
docker compose up --build
```

That starts Nginx on **http://localhost** (the only API entry point), the
gateway, the worker, Postgres, Redis, the fake bank, and a merchant-mock
that receives webhooks at **http://localhost:4000/webhooks**. On first
start, Postgres loads `db/schema.sql` and `db/seed.sql`, which create two
merchants with fixed, **dev-only** credentials:

| Merchant | API key | Webhook secret |
|---|---|---|
| Test Merchant | `dev_test_key_merchant_1` | `dev_webhook_secret_merchant_1` |
| Second Merchant | `dev_test_key_merchant_2` | `dev_webhook_secret_merchant_2` |

```bash
# create a payment
curl -s -X POST localhost/payments \
  -H 'x-api-key: dev_test_key_merchant_1' -H 'Content-Type: application/json' \
  -d '{"idempotency_key": "order_1", "amount": 499.50}'

# run it through the state machine (calls the fake bank)
curl -s -X POST localhost/payments/<id>/process -H 'x-api-key: dev_test_key_merchant_1'

# read it back: events, webhook delivery status, X-Cache header
curl -si localhost/payments/<id> -H 'x-api-key: dev_test_key_merchant_1'

curl -s localhost:4000/webhooks                                            # what the merchant received
curl -s localhost/health                                                   # every dependency
curl -s localhost/metrics -H 'x-admin-token: dev-admin-token'              # volume, success rate, p95
curl -s -X POST localhost/admin/reconciliation/$(date -u +%F) -H 'x-admin-token: dev-admin-token'
```

End-to-end checks and tools (Node 22 on your machine, no install needed
for these scripts):

```bash
GATEWAY_URL=http://localhost API_KEY=dev_test_key_merchant_1 ADMIN_TOKEN=dev-admin-token npm run smoke
GATEWAY_URL=http://localhost API_KEY=dev_test_key_merchant_2 npm run ratelimit-test
```

Knobs:

```bash
BANK_BEHAVIOR=always_timeout docker compose up -d fake-bank   # force PENDING
MERCHANT_FAIL_RATE=1 docker compose up -d merchant-mock       # force webhook retries -> dead letter
docker compose up -d --scale gateway=3                        # horizontal scale behind Nginx
docker compose down        # keeps data (named volumes)
docker compose down -v     # wipes it; next up re-runs schema + seed
```

### Running without Docker

Needs Node 22, Postgres 16 and Redis 7 running locally.

```bash
npm install && (cd fake-bank && npm install)
createdb payments && psql -d payments -f db/schema.sql -f db/seed.sql
cp .env.example .env     # set DATABASE_URL; ADMIN_TOKEN for /metrics and /admin
# the seed's webhook_url points at the Docker hostname -- for local runs:
psql -d payments -c "UPDATE merchants SET webhook_url = 'http://localhost:4000/webhook'"

MERCHANT_WEBHOOK_SECRETS=dev_webhook_secret_merchant_1,dev_webhook_secret_merchant_2 npm run merchant-mock
npm run fake-bank
npm start
npm run worker
```

For a database created by an earlier phase, run the numbered files in
`db/migrations/` in order instead; each is safe to re-run. If your shell
already exports `DATABASE_URL`, dotenv won't override it with `.env`.

## Technical decisions

The ten that shaped the system most (full reasoning, alternatives and
tradeoffs for all 22 are in [`DECISIONS.md`](DECISIONS.md)):

1. **Postgres, raw SQL, no ORM** (001, 003) — multi-statement ACID
   transactions are non-negotiable for money, and an ORM would hide exactly
   the mechanics this project is about.
2. **Append-only `payment_events` + a single `transitionStatus` chokepoint**
   (005) — history is never overwritten, and no code path can skip a state
   or apply two racing transitions (row lock + expected-status check).
3. **`PROCESSING` committed before the bank call; no DB connection held
   during it** (010) — a crash never leaves a payment looking safe to
   retry, and a slow bank never drains the connection pool.
4. **Idempotency: the DB constraint is the guarantee, the Redis lock is the
   optimisation** (004, 011) — token + Lua compare-and-delete lock, fails
   open, same key with a different amount → 422.
5. **Transactional outbox for webhooks** (012) — the webhook row commits in
   the same transaction as the status change; a sweeper guarantees it
   reaches the queue even if Redis or the process dies in between.
6. **At-least-once, HMAC-signed webhooks with exponential backoff and a
   dead-letter state** (013) — exactly-once over HTTP is impossible, so
   merchants dedupe on a stable `X-Webhook-Id`.
7. **Ambiguity is `PENDING`, resolved by lookup, never by re-charging**
   (014) — timeouts and connection errors alike; stale `PROCESSING` is
   rescued; the fake bank keeps a persistent, idempotent ledger.
8. **Cache only what can never change** (018) — terminal payments only, so
   there is no invalidation code to get wrong.
9. **Liveness vs readiness, graceful shutdown longer than the bank
   timeout** (020) — a DB outage never makes Docker restart the gateway,
   and `docker stop` never cuts off a payment mid-flight.
10. **Reconciliation on `payment_id` with integer money comparison** (021)
    — finds "bank charged, we said failed", which matching on
    `bank_reference` cannot.

## Problems hit and solved

Every one of these was found by actually running the system (smoke tests,
failure injection, load tests), not by reading the code:

- **Bank unreachable → 500 and a payment stuck in `PROCESSING` forever.**
  Only timeouts had been treated as ambiguous. Now every non-definitive
  bank answer becomes `PENDING`, and a worker rescues anything left in
  `PROCESSING` for over two minutes (a crash mid-call).
- **A webhook could be lost between the DB commit and the queue.** Fixed
  with a transactional outbox plus a sweeper; verified by inserting an
  outbox row with no job (simulating a crash) and watching it get delivered.
- **Redis restarting without persistence silently stopped all background
  recovery**, because the job schedulers lived in Redis. The worker now
  re-registers them on every reconnect, and compose runs Redis with AOF.
- **Concurrent duplicate requests.** 10 simultaneous creates with one key,
  and later 2,000 creates sent as simultaneous pairs, produced exactly one
  payment per key, with no 500s.
- **Graceful shutdown took 5s longer than it should.** Nginx's pooled
  keep-alive connection went idle *after* the one-time idle-connection close
  and sat until Node's keep-alive timeout. Now idle sockets are closed
  repeatedly while draining; `docker stop` mid-payment takes exactly as
  long as the in-flight request.
- **The plan's reconciliation would have been wrong twice over.** Comparing
  the bank's `999.5` with Postgres's `"999.50"` using `!==` flags every
  payment, and matching on `bank_reference` can't see charged-but-FAILED
  payments. Both fixed, and `TIMESTAMP` columns became `TIMESTAMPTZ` so day
  boundaries mean the same thing in every time zone.
- **A fixed-window rate limiter allows 2× the limit across a minute
  boundary.** Replaced with a sliding-window log in one Lua script; 99
  concurrent requests all allowed, the 101st rejected.
- Smaller ones: errored requests' latency filed under the wrong route
  (Express resets `req.baseUrl` before the error handler), `/health`
  dumping raw driver objects, 500 responses leaking internal error text,
  non-UUID ids causing 500s, migration 002 not being re-runnable.

## Load test results

`scripts/loadTest.js`, 1,000 payments at concurrency 50, **every create
sent twice at the same instant**, run in Docker against the gateway
directly (`docker-compose.loadtest.yml` lifts the rate limits so the test
measures the payment path, not the limiters):

| | Random bank (15% timeouts) | Bank always succeeds |
|---|---|---|
| Creates (2,000 requests) | 651 req/s · p50 103 ms · p95 211 ms · p99 575 ms | 890 req/s · p50 83 ms · p95 140 ms · p99 235 ms |
| `/process` (1,000 requests) | 24 req/s · p50 568 ms · p95 10,013 ms | 90 req/s · p50 527 ms · p95 792 ms |
| Outcomes | 731 SUCCESS · 269 FAILED (132 went PENDING, all resolved in 67s) | 1,000 SUCCESS |
| Rows created for 1,000 keys | exactly 1,000 | exactly 1,000 |
| 5xx / network errors | 0 | 0 |
| Broken event chains | 0 | 0 |
| Webhooks per terminal payment | exactly 1, all delivered | exactly 1, all delivered |

`/process` throughput is bounded by the bank, not the gateway (Little's
law): 50 in flight ÷ ~0.55s bank latency ≈ 90/s; add 15% ten-second
timeouts and the average becomes ~2s, so ≈ 24/s. The gateway's own work
per `/process` is about 27 ms.

Reconciliation over the same data matched all 1,748 successful payments
(₹96,481.50 on both sides), then caught every deliberately injected
problem, including a "bank charged, we said FAILED" case.

## What I would do at 10× scale

- **Decouple from the bank.** Throughput is bank-latency bound. Make
  `/process` asynchronous (202 + queue + webhook), and put a circuit
  breaker and concurrency cap around the bank call so a slow bank can't
  tie up every gateway instance.
- **Postgres.** 20 pooled connections per instance runs out fast, so put
  PgBouncer in front; send reads to replicas (terminal payments are already
  immutable); partition `payments` / `payment_events` by month; archive
  delivered outbox rows.
- **Redis high availability** (Sentinel or a managed cluster). Correctness
  doesn't depend on Redis (everything fails open or is backed by Postgres),
  but availability of retries and schedules does.
- **Per-merchant webhook queues**, so one merchant with a dead endpoint
  can't delay everyone else's deliveries; add a dead-letter replay endpoint.
- **Rate limiting:** switch to a sliding-window *counter* (O(1) memory) for
  high limits, and store per-merchant limits in the DB.
- **Observability:** Prometheus histograms and alerts instead of the Redis
  latency sample; OpenTelemetry tracing across Nginx → gateway → bank.
- **Reconciliation:** continuous rather than daily, streamed or joined in
  the DB instead of loaded into memory, with automatic tickets for critical
  discrepancies.

## Repository guide

| Path | What it is |
|---|---|
| `src/` | gateway (`index.js`) and worker (`worker.js`) |
| `fake-bank/`, `merchant-mock/` | the two external systems, simulated |
| `db/schema.sql`, `db/seed.sql`, `db/migrations/` | schema, dev seed, incremental migrations |
| `docker-compose.yml`, `nginx/`, `Dockerfile`s | the whole system in containers |
| `scripts/` | smoke test, load test, rate-limit test, reconciliation CLI |
| `DECISIONS.md` | 22 major decisions with alternatives and tradeoffs |
| `PROGRESS.md` | project status and how each phase was verified |
| `docs/phase1…6_theory_reference.docx` | study notes, one per phase |
| `paymentGatewayPlan.pdf` | the original six-phase plan |
