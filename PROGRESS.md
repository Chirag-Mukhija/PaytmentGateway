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

**Working mode change (2026-09-26):** Phases 3–6 were built in one
autonomous pass at the owner's request, with the owner reviewing everything
at the end. Each phase has a matching `phaseN_theory_reference.docx` for
study, and every phase was run against real Postgres + Redis (and, from
Phase 5, real Docker) before it was committed — see §5.

## 2. Six build phases — all done

| # | Phase | Status | What it covers |
|---|-------|--------|-----------------|
| 1 | Foundation | **Done, verified live** | Express skeleton, Postgres schema, pooling, API-key auth, payment CRUD, DB-level idempotency |
| 2 | Fake Bank + Lifecycle | **Done, verified live** | Fake bank server, INITIATED → PROCESSING → SUCCESS/FAILED/PENDING via `transitionStatus`, bank call outside any held connection |
| 3 | Idempotency + Retry | **Done, verified live** | Redis idempotency lock, transactional outbox + BullMQ webhook retries/dead letter, signed webhooks, PENDING resolution + stale-PROCESSING rescue, separate worker process |
| 4 | Redis (rate limit/cache/metrics) | **Done, verified live** | Per-merchant sliding-window rate limit, cached merchant auth lookup, terminal-payment cache (no invalidation needed), `GET /metrics` |
| 5 | Docker + Nginx | **Done, verified in Docker** | One-command `docker compose up --build`, Nginx edge (per-IP limit, request ids, JSON logs, scaling), liveness vs readiness, worker heartbeat, graceful shutdown |
| 6 | Reconciliation + Polish | **Done, verified in Docker** | Daily reconciliation (+ admin endpoint + CLI), `TIMESTAMPTZ` everywhere, structured JSON logging with request-id propagation, 5xx hygiene, load test, final README |

The original plan is `paymentGatewayPlan.pdf`. Where the build deviates
from it, the deviation and the reason are in `DECISIONS.md` (for example:
no Redis idempotency *result* cache, a real sliding window instead of the
sample's fixed window, reconciliation on `payment_id` instead of
`bank_reference`, JavaScript kept instead of the optional TypeScript switch).

## 3. Current architecture

**Processes (all started by `docker compose up --build`, see README.md):**
```
Nginx           nginx/nginx.conf  the only public entry point: per-IP limit,
                                   request ids, JSON access log, load balancing
API server      src/index.js      create / process / read payments, health,
                                   metrics, admin (reconciliation)
Worker          src/worker.js     webhook delivery, PENDING resolution, outbox
                                   sweep, daily reconciliation, heartbeat
Fake bank       fake-bank/        POST /charge (random success/fail/hang),
                                   lookup + ledger endpoints, persistent ledger
Merchant mock   merchant-mock/    receives + verifies signed webhooks, dedupes
Postgres                          source of truth: payments, events, outbox,
                                   reconciliation reports
Redis                             idempotency locks, rate-limit windows,
                                   caches, latency samples, BullMQ queues
```

**Folder structure:**
```
src/
├── index.js / app.js            API entry (graceful shutdown) + Express app
├── worker.js                    worker entry: jobs, schedulers, heartbeat
├── lib/logger.js                JSON logger + AsyncLocalStorage context
├── config/  db.js, redis.js     pg Pool; two Redis connection profiles
├── middleware/                  requestLogger, requestMetrics, auth (cached),
│                                rateLimiter, adminAuth, errorHandler
├── routes/                      payments.js, metrics.js, admin.js
├── controllers/paymentController.js   validation + HTTP shaping
├── services/
│   ├── paymentService.js        all payment SQL, transitionStatus,
│   │                            createPaymentIdempotent, applyBankOutcome,
│   │                            outbox insert, processPayment, readPayment
│   ├── idempotencyService.js    Redis lock (SET NX EX + Lua release)
│   ├── bankClient.js            charge + lookup, BANK_TIMEOUT / BANK_UNREACHABLE
│   ├── webhookService.js        one signed delivery attempt
│   ├── cache.js                 fail-open Redis get/set helpers
│   ├── metricsService.js        latency samples + /metrics aggregation
│   └── healthService.js         /health dependency checks
├── queues/webhookQueue.js       BullMQ producer
└── jobs/                        webhookWorker, pendingResolutionJob,
                                 outboxSweeper, reconciliationJob
fake-bank/  merchant-mock/       simulated external systems (+ Dockerfiles)
scripts/                         smokeTest, loadTest, rateLimitTest, reconcile
db/schema.sql                    full current schema (fresh installs)
db/seed.sql                      dev-only merchants (compose first boot)
db/migrations/00N_*.sql          incremental, idempotent, run in order
Dockerfile, docker-compose.yml, docker-compose.loadtest.yml, nginx/
phase1..6_theory_reference.docx  study notes, one per phase
DECISIONS.md                     22 major decisions + smaller choices footer
```

**Request flow, end to end:**
1. Nginx (per-IP limit, request id) → `POST /payments` → request logger
   (context) → auth (merchant cached 30s) → per-merchant rate limit →
   validation → `createPaymentIdempotent`: DB check → Redis lock → DB
   re-check → insert payment + first event → release lock.
2. `POST /payments/:id/process` → tx1: lock row, INITIATED → PROCESSING,
   commit → bank call (no connection held) → tx2: record outcome +
   transition (+ outbox row if SUCCESS/FAILED) → fast-path enqueue.
3. Worker delivers the webhook (signed, retried with backoff, dead-lettered
   after 5 attempts). Every 30s it rescues stale PROCESSING payments,
   resolves PENDING ones by asking the bank, and re-enqueues orphaned
   outbox rows. At 00:10 UTC it reconciles the previous day.

## 4. Key design decisions

`DECISIONS.md` is the single source of truth: 22 major decisions, each with
the alternatives considered, plus a footer of smaller choices. The README's
"Technical decisions" section summarises the ten that shaped the system most.

## 5. How each phase was verified

All of this was run in the build container against real Postgres 16 and
Redis 7 (and, from Phase 5, the full Docker Compose stack), using
`scripts/smokeTest.js`, `scripts/loadTest.js`, `scripts/rateLimitTest.js`
and targeted failure injection:

- **Phase 1–2:** auth/validation/idempotency checks; 20- and 50-payment
  runs (mix of SUCCESS/FAILED/PENDING); every event chain unbroken; five
  concurrent `/process` calls on one payment → exactly one 200, four 409s;
  forced bank timeout → PENDING after 10s with the server healthy.
- **Phase 3:** 10 concurrent creates with one key → exactly one payment,
  no 500s; same key + different amount → 422; forced timeout → PENDING →
  SUCCESS via bank lookup; bank shut down → PENDING (200, not 500) → FAILED
  after the give-up window; merchant failing 60% → every webhook eventually
  delivered; merchant failing 100% → dead_letter after 5 attempts; orphaned
  outbox row → delivered by the sweeper; payment abandoned in PROCESSING →
  rescued; Redis shut down with no persistence → create/process unaffected,
  webhook delivered after Redis returned.
- **Phase 4:** 99 concurrent requests after the first → all allowed, the
  101st → 429, a second merchant unaffected; terminal payment GET →
  `X-Cache: HIT`, identical field-for-field to the uncached response;
  non-terminal payments never cached; `/metrics` rejects merchant keys;
  Redis shut down → auth, rate limit, cache and metrics all degrade cleanly.
- **Phase 5 (Docker):** 7 services healthy from one command; smoke test
  passes through Nginx with every webhook signature verified; worker
  stopped → `/health` degraded immediately; Postgres stopped → 503 while
  liveness stays 200; `docker stop` 2s into a 10s bank call → request
  completed with 200, container exited 8.3s later; `down` + `up` → data
  intact; 400 invalid-key requests from one IP → Nginx rejected 259;
  `--scale gateway=3` → requests split 20/20/20, smoke test passed across
  all three.
- **Phase 6 (Docker):** load test, 1,000 payments at concurrency 50 with
  every create duplicated → exactly 1,000 rows, 0 errors, 0 broken event
  chains, exactly one delivered webhook per payment, all 132 timeouts
  resolved within 67s (full numbers in README); reconciliation matched all
  1,748 real successes, then caught each injected problem — amount changed,
  SUCCESS flipped to FAILED, forged SUCCESS, and a charged-but-FAILED
  payment — as critical, while two charged-but-PENDING payments were
  warnings that disappeared once the worker resolved them; Nginx and
  gateway log lines join on one request id; a 500 no longer leaks error
  text. README's non-Docker setup followed verbatim on a fresh DB → all
  checks pass.

*(Build-container note: its network intercepts TLS, so Docker images were
built there through a sandbox-only override that trusts that proxy's CA.
The committed Dockerfiles need nothing extra on a normal machine.)*

**Bugs found and fixed by running it:** migration 002 not re-runnable;
bank unreachable → 500 + payment stuck in PROCESSING forever; non-UUID id
→ 500; `GET /payments` lacked the plan's status filter and total; job
schedulers lost when Redis restarted without persistence; latency metrics
for errored requests filed under the wrong route; `/health` dumped raw
driver objects; graceful shutdown waited an extra 5s on an idle Nginx
keep-alive socket; Nginx sent requests to a replaced container's old IP
until DNS re-resolved (interval cut to 5s); reconciliation counted a
SUCCESS→FAILED row as matched (now `status_regression`); `TIMESTAMP`
without time zone; 500s leaking internal error messages; dotenv's banner
breaking JSON-only logs.

## 6. Next concrete steps (for the owner)

1. Pull the branch, run `docker compose up --build`, then the smoke test
   and load test from the README — confirm it all behaves the same on
   your Mac.
2. Study phase by phase: read `phaseN_theory_reference.docx`, then the
   files it lists, then answer its "questions to answer after each file"
   without looking.
3. Review `DECISIONS.md` 011–022 critically — they were written for your
   review, not recalled by you; push back on anything you wouldn't defend.

## 7. Open questions / known issues

- **Dead-lettered webhooks have no replay endpoint** — visible in
  `webhook_deliveries` and on `GET /payments/:id`, but re-sending one needs
  a manual DB update.
- **Critical reconciliation discrepancies are reported, not fixed** — no
  refund/correction flow exists (by design for this scope).
- **No unit-test suite.** `scripts/` holds end-to-end tests against
  running services; a unit/integration suite with a test DB would be the
  next step (framework not chosen for you).
- **One global rate limit** for every merchant; per-merchant limits would
  need a column on `merchants`.
- **Local env quirk:** if your shell already exports `DATABASE_URL`, dotenv
  will not override it with `.env`.
