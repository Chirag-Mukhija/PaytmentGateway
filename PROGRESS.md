# PROGRESS.md

Last updated: 2026-09-15
Update this file at the end of every session, before wrapping up.

---

## 1. Project summary

This is a payment gateway built to *understand* backend engineering, not
just to produce a working API. It deliberately takes on the hard parts of
real payment systems instead of stubbing them: idempotency (so a retried
network request can't double-charge), an explicit payment state machine
with an append-only audit trail (so "what happened to this payment" is
never lost to an in-place status overwrite), the dual-write problem
(keeping a local DB and an external bank/processor in sync — coming in
Phase 2), and reconciliation (catching drift between our records and the
bank's, coming in Phase 6). Every non-trivial choice is logged in
`DECISIONS.md` with a rule attached: if the reasoning/tradeoff can't be
filled in from memory, the decision isn't understood yet and shouldn't be
defended in an interview.

## 2. Six build phases

| # | Phase | Status | What it covers |
|---|-------|--------|-----------------|
| 1 | Foundation | Code complete; DECISIONS.md review done, Study Guide Q1 still open — see §5 | Express app skeleton, Postgres schema, connection pooling, API-key auth middleware, payment CRUD endpoints, DB-level idempotency check |
| 2 | Fake Bank + Lifecycle | **In progress** — code written, not yet run/tested locally | Fake bank server (`fake-bank/`), the full payment state machine (INITIATED → PROCESSING → SUCCESS/FAILED/PENDING) via a single `transitionStatus` chokepoint, bank call outside any held DB connection, simple fire-and-forget webhook |
| 3 | Idempotency + Retry | Not started | Closing the race condition the Phase 1 pre-check doesn't fully solve; Redis-based locking; retry logic for failed bank calls |
| 4 | Redis (rate limit/cache) | Not started | Per-merchant rate limiting, caching hot reads |
| 5 | Docker + Nginx | Not started | Containerizing the app + Postgres + Redis; Nginx as reverse proxy |
| 6 | Reconciliation + Polish | Not started | Batch job comparing our records against the bank's; cleanup pass |

Full detail (schema, endpoints, done-criteria per phase) lives in
`paymentGatewayPlan.pdf`; concept primers live in `docs/STUDY_GUIDE.md`.

## 3. Current architecture

**Stack:** Node.js, Express 5, PostgreSQL (`pg` library, no ORM). Native
`fetch`/`AbortController` for outbound HTTP (bank + webhook calls) instead
of adding `axios`. Redis + BullMQ + Docker still planned, not yet
introduced.

**Folder structure (as built):**
```
src/
├── index.js                  entry point — loads .env, starts server
├── app.js                    Express app: requestLogger → json parser →
│                              /health → /payments router → errorHandler
├── config/db.js              pg Pool (max 20 connections), error listener
│                              on idle clients so a dropped DB connection
│                              doesn't crash the process
├── middleware/
│   ├── auth.js                reads x-api-key, looks up merchant, attaches
│   │                          req.merchant, 401s if missing/invalid
│   ├── errorHandler.js        4-arg handler, registered last; Express 5
│   │                          auto-forwards async errors here (no manual
│   │                          try/catch + next(err) needed in routes)
│   └── requestLogger.js       logs method/url/status/duration on res 'finish'
├── routes/payments.js        router; auth applied to all routes below it;
│                              POST /, POST /:id/process, GET /:id, GET /
├── controllers/
│   └── paymentController.js  request validation, calls paymentService,
│                              shapes HTTP responses (400/404/409/201/200)
└── services/
    ├── paymentService.js     all DB queries; transitionStatus is the only
    │                          function allowed to change payment_status;
    │                          processPayment runs the Phase 2 state machine
    ├── bankClient.js          calls fake-bank's /charge with a 10s
    │                          AbortController timeout → BANK_TIMEOUT error
    └── webhookService.js      fire-and-forget POST to merchant.webhook_url

fake-bank/                    separate Express app (port 5000, own
                               package.json) — POST /charge randomly
                               succeeds/fails/times out (BANK_BEHAVIOR env
                               var forces a specific outcome for testing)

db/schema.sql                 merchants, payments, payment_events tables
                               + indexes (see DECISIONS.md for the
                               reasoning behind each table)
db/migrations/002_phase2_bank_columns.sql
                               ALTER TABLE adding bank_reference and
                               failure_reason to payments — run this
                               against an already-existing local DB;
                               schema.sql itself was also updated in place
                               for anyone running it fresh
docs/STUDY_GUIDE.md           concept primers (middleware, pooling,
                               parameterized queries, transactions,
                               DECIMAL vs FLOAT, idempotency, CHECK
                               constraints)
DECISIONS.md                  the current source of truth for every
                               architectural decision and its
                               reasoning/tradeoff — see §4 for how it's
                               scoped
```

**How it connects (Phase 1 flow):** a request hits `requestLogger` →
Express's JSON parser → `/payments` router → `auth` middleware (attaches
`req.merchant`) → controller (validates input, shapes response) → service
(owns all SQL) → Postgres via a pooled connection. Any thrown/rejected
error from an async handler anywhere in that chain falls through to
`errorHandler.js` automatically (Express 5 behavior).

**Phase 2 addition:** `POST /payments/:id/process` moves a payment through
`INITIATED → PROCESSING → SUCCESS/FAILED/PENDING`. `PROCESSING` is written
and committed *before* the bank is called, and no pooled DB connection is
held during the bank call itself — see DECISIONS.md #010 for why both of
those are load-bearing, not stylistic.

## 4. Key design decisions made so far

`DECISIONS.md` was deliberately trimmed to only the decisions that trade
real properties against each other (9 entries as of Phase 2) — smaller
implementation-detail choices (UUID vs SERIAL, CHECK constraints, etc.)
were cut to a footer note rather than tracked as full entries. Treat
`DECISIONS.md` itself as the single source of truth going forward; this
file won't re-list every entry (that's what caused a stale cross-reference
in §7 last session — a decision got renumbered and this file didn't know).

## 5. What's in progress right now

**Phase 1** is effectively done: `DECISIONS.md` was reviewed and trimmed
entry-by-entry (dual-write reasoning rewritten after review), and 2 of the
3 Study Guide questions have been covered in depth in conversation
(the idempotency race, and why `payment_events` is separate). Still open:

- **Study Guide Q1** — why does `auth.js` attach `merchant` to `req`
  instead of passing the API key down to every function that needs it?
  Not yet explicitly gone through.

**Phase 2** code is written but **unverified** — this session had no DB
connection and wasn't meant for running the app, so none of this has
actually been executed yet:
- `fake-bank/` (separate Express app, its own `package.json` — needs its
  own `npm install` before it'll run)
- `db/migrations/002_phase2_bank_columns.sql` — needs to actually be run
  against the local DB (`schema.sql` alone won't add the columns to an
  already-existing table)
- `paymentService.transitionStatus` + `processPayment`, `bankClient.js`,
  `webhookService.js`, and the new `POST /payments/:id/process` route

## 6. Next 2-3 concrete steps

1. Locally: `npm install` in both the repo root and `fake-bank/`, run the
   new migration, start both servers, and actually exercise
   `POST /payments/:id/process` — confirm the Phase 2 "Done When" checklist
   in `paymentGatewayPlan.pdf` (mix of SUCCESS/FAILED/PENDING across ~20
   runs, no skipped status, forced-timeout scenario doesn't crash the
   server, webhook fires on terminal states).
2. Close out Study Guide Q1 before calling Phase 1 fully done (mostly a
   formality at this point, but per the project's own rule, worth doing
   explicitly rather than assuming).
3. Once Phase 2 is verified working: Phase 3 (Redis-backed idempotency
   lock taken *before* work starts, webhook retry queue, PENDING
   resolution job) — don't start that code before Phase 2 is confirmed
   working locally.

## 7. Open questions / known issues

- **Idempotency race condition is not fully closed.** The `SELECT`
  pre-check + `23505` catch prevents a duplicate *row*, but doesn't
  prevent two near-simultaneous requests from both doing real work before
  one gets rejected. Phase 3's Redis lock is the actual fix — flagged in
  both `DECISIONS.md` #007 and `paymentService.js` comments, not a bug,
  a known deferred item.
- **Phase 2's dual-write gap is real, not just documented.** Between
  `PROCESSING` committing and the second transaction recording the bank's
  outcome, a crash leaves the payment stuck in `PROCESSING` forever unless
  something (Phase 3's PENDING job for the `BANK_TIMEOUT` path; nothing
  yet for a genuine crash/network error mid-call) goes looking for it —
  see `DECISIONS.md` #010.
- **No tests exist yet** (`package.json` test script is the default
  placeholder). Not yet decided which testing approach/library to use —
  per CLAUDE.md's standing rule, that should be presented as options with
  tradeoffs when it comes up, not decided unilaterally.
- **`src/middleware/.cph/` directory**: earlier session flagged a stray
  `.cph/.requestLogger.js_*.prob` file (Competitive Programming Helper
  VS Code extension artifact, not project source) that had gotten
  git-staged. Confirm it's excluded going forward (check `.gitignore`)
  rather than accidentally re-staging it in a future commit.
