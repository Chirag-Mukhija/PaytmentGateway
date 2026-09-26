# PROGRESS.md

Last updated: 2026-09-26
Update this file at the end of every session, before wrapping up.

---

## 1. Project summary

This is a payment gateway built to *understand* backend engineering, not
just to produce a working API. It deliberately takes on the hard parts of
real payment systems instead of stubbing them: idempotency (so a retried
network request can't double-charge), an explicit payment state machine
with an append-only audit trail, the dual-write problem (a local DB and an
external bank can't share a transaction), reliable webhooks (the same
problem again, between the DB and a queue), and reconciliation (catching
drift between our records and the bank's). Every non-trivial choice is
logged in `DECISIONS.md` with the alternatives that were considered.

**Working mode change (2026-09-26):** from Phase 3 onward, all remaining
phases were built in one autonomous pass at the owner's request, with the
owner reviewing everything at the end. Each phase has a matching
`phaseN_theory_reference.docx` for study, and every phase was run against
real Postgres + Redis before being committed (see §5).

## 2. Six build phases

| # | Phase | Status | What it covers |
|---|-------|--------|-----------------|
| 1 | Foundation | **Done, verified live** | Express skeleton, Postgres schema, pooling, API-key auth, payment CRUD, DB-level idempotency |
| 2 | Fake Bank + Lifecycle | **Done, verified live** | Fake bank server, INITIATED → PROCESSING → SUCCESS/FAILED/PENDING via `transitionStatus`, bank call outside any held connection |
| 3 | Idempotency + Retry | **Done, verified live** | Redis idempotency lock, transactional outbox + BullMQ webhook retries/dead letter, signed webhooks, PENDING resolution + stale-PROCESSING rescue, separate worker process |
| 4 | Redis (rate limit/cache/metrics) | **Done, verified live** | Per-merchant sliding-window rate limit, cached merchant auth lookup, terminal-payment cache (no invalidation needed), `GET /metrics` (volume, success rate, p50/p95/p99, webhook backlog) |
| 5 | Docker + Nginx | **Done, verified live in Docker** | One-command `docker compose up --build` (7 services), Nginx edge (per-IP limit, request ids, JSON logs, scaling), liveness vs readiness health, worker heartbeat, graceful shutdown |
| 6 | Reconciliation + Polish | Not started | Daily reconciliation job, structured logging, load test, final README |

Full plan (schema, endpoints, done-criteria per phase) is in
`paymentGatewayPlan.pdf`. Where the build deviates from the plan, the
deviation and its reason are in `DECISIONS.md`.

## 3. Current architecture

**Processes:**
```
API server      src/index.js      HTTP: create / process / read payments
Worker          src/worker.js     webhook delivery, PENDING resolution, outbox sweep
Fake bank       fake-bank/        POST /charge (random success/fail/timeout),
                                   GET /transactions/:payment_id, persistent ledger
Merchant mock   merchant-mock/    receives + verifies webhooks, dedupes by id
Postgres                          source of truth for payments, events, outbox
Redis                             idempotency locks, BullMQ queues + schedulers,
                                   rate-limit windows, caches, latency samples
Nginx           nginx/nginx.conf  the only public entry point (Phase 5)
```

`docker compose up --build` runs all of the above; see README.md.

**Folder structure (as built):**
```
src/
├── index.js / app.js            API entry + Express app
├── worker.js                    background worker entry (Phase 3), heartbeat (Phase 5)
├── config/  db.js, redis.js     pg Pool; two Redis connection profiles
├── middleware/                  auth (cached lookup), rateLimiter, requestMetrics,
│                                errorHandler, requestLogger
├── routes/payments.js           POST /, POST /:id/process, GET /:id, GET /
├── routes/metrics.js            GET /metrics (admin token)
├── controllers/paymentController.js   validation + HTTP shaping
├── services/
│   ├── paymentService.js        all payment SQL, transitionStatus,
│   │                            createPaymentIdempotent, applyBankOutcome,
│   │                            outbox insert, processPayment
│   ├── idempotencyService.js    Redis lock (SET NX EX + Lua release)
│   ├── bankClient.js            charge + lookup, BANK_TIMEOUT / BANK_UNREACHABLE
│   ├── webhookService.js        one signed delivery attempt
│   ├── cache.js                 fail-open Redis get/set helpers
│   ├── metricsService.js        latency samples + /metrics aggregation
│   └── healthService.js         /health dependency checks (Phase 5)
├── queues/webhookQueue.js       BullMQ producer
└── jobs/                        webhookWorker, pendingResolutionJob, outboxSweeper
fake-bank/src/index.js
merchant-mock/index.js
scripts/smokeTest.js             end-to-end checks for every phase so far
scripts/rateLimitTest.js         101st request in a minute -> 429
db/schema.sql                    full current schema (fresh installs)
db/seed.sql                      dev-only merchants, loaded by compose on first boot
db/migrations/00N_*.sql          incremental, idempotent (IF NOT EXISTS)
Dockerfile, fake-bank/Dockerfile, merchant-mock/Dockerfile, .dockerignore
docker-compose.yml               the whole system
nginx/nginx.conf                 reverse proxy config
phaseN_theory_reference.docx     study notes per phase (1-5 so far)
DECISIONS.md                     20 major decisions + smaller choices footer
```

**Request flow, end to end:**
1. `POST /payments` → auth (merchant cached 30s) → rate limit → validation → `createPaymentIdempotent`: DB
   check → Redis lock → DB re-check → insert payment + first event → release.
2. `POST /payments/:id/process` → tx1: lock row, INITIATED → PROCESSING,
   commit → bank call (no connection held) → tx2: record outcome + transition
   (+ outbox row if SUCCESS/FAILED) → fast-path enqueue of the webhook.
3. Worker delivers the webhook (signed, retried with backoff, dead-lettered
   after 5 attempts). Every 30s it rescues stale PROCESSING payments, resolves
   PENDING ones by asking the bank, and re-enqueues any orphaned outbox rows.

## 4. Key design decisions

`DECISIONS.md` is the single source of truth. It was trimmed to only the
decisions that trade real properties against each other; smaller choices
are listed in its footer.

## 5. How each phase was verified

All of this was run in the build container against real Postgres 16 and
Redis, using `scripts/smokeTest.js` plus targeted failure scenarios:

- **Phase 1–2:** auth/validation/idempotency checks; 20 and 50 payment
  runs (mix of SUCCESS/FAILED/PENDING); every event chain unbroken; five
  concurrent `/process` calls on one payment → exactly one 200, four 409s;
  forced bank timeout → PENDING after 10s with server healthy.
- **Phase 3:** 10 concurrent creates with one key → exactly one payment,
  no 500s; same key + different amount → 422; forced timeout → PENDING →
  SUCCESS via bank lookup; bank shut down → PENDING (200, not 500) → FAILED
  after give-up window; merchant failing 60% → every webhook eventually
  delivered; merchant failing 100% → dead_letter after 5 attempts; orphaned
  outbox row → delivered by sweeper; payment abandoned in PROCESSING →
  rescued; Redis shut down with no persistence → create/process unaffected,
  webhook delivered after Redis returned; 50-payment run → zero payments
  left PENDING/PROCESSING, zero undelivered webhooks.
- **Phase 4:** 99 concurrent requests after the first → all allowed, the
  101st → 429 with Retry-After, a second merchant unaffected; terminal
  payment GET → `X-Cache: HIT` and identical field-for-field to the
  uncached response; non-terminal payments never cached; `/metrics`
  rejects merchant keys, reports success rate + p95 (process p95 ≈ 10s,
  entirely bank timeouts); Redis shut down → auth, rate limit, cache and
  metrics all degrade without errors.
- **Phase 5 (in real Docker):** all 7 services up and healthy from one
  command; full smoke test passes through Nginx on port 80 with
  merchant-mock verifying every webhook signature; `/health` → ok,
  worker stopped → degraded immediately, Postgres stopped → 503 while
  liveness stays 200; `docker stop` 2s into a 10s bank call → request
  completed with 200, container exited 8.3s later; `down` + `up` → all
  payments and the bank ledger intact; 400 invalid-key requests from one
  IP → Nginx rejected 259 before they reached Node; `--scale gateway=3` →
  requests split exactly 20/20/20 and the smoke test passed across all
  three instances.
  *(Build-container note: its network intercepts TLS, so images were
  built there through a sandbox-only override that trusts that proxy's
  CA. The committed Dockerfiles need nothing extra on a normal machine.)*

**Bugs found and fixed by running it:** migration 002 wasn't re-runnable;
bank unreachable → 500 + payment stuck in PROCESSING forever; non-UUID id →
500; `GET /payments` lacked the plan's status filter and total count; job
schedulers were lost when Redis restarted without persistence; latency
metrics for errored requests were filed under the wrong route (Express
resets `req.baseUrl` before the error handler runs); `/health` dumped raw
pg/Redis return values; graceful shutdown waited an extra 5s on an idle
Nginx keep-alive socket; after a gateway container was replaced, Nginx
sent requests to its old IP until DNS re-resolved (interval cut to 5s).

## 6. Next concrete steps

1. Phase 6 — reconciliation, structured logging, load test, final README.

## 7. Open questions / known issues

- **Dead-lettered webhooks have no replay endpoint.** They are visible in
  `webhook_deliveries` (and on `GET /payments/:id`) but re-sending one
  needs a manual DB update today.
- **No automated test suite** beyond `scripts/smokeTest.js` (an end-to-end
  script against running services). Unit tests with a test DB would be the
  next step; not chosen for you yet.
- **Local env quirk:** if your shell already exports `DATABASE_URL`, dotenv
  will not override it with `.env` (that bit the build container).
