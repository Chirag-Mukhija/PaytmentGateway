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
| 1 | Foundation | **In progress** (core code written, understanding not yet locked in — see §5) | Express app skeleton, Postgres schema, connection pooling, API-key auth middleware, payment CRUD endpoints, DB-level idempotency check |
| 2 | Fake Bank + Lifecycle | Not started | A fake external "bank" service to call; the full payment state machine (INITIATED → PROCESSING → SUCCESS/FAILED); the dual-write problem (DB write + bank call can't be atomic) |
| 3 | Idempotency + Retry | Not started | Closing the race condition the Phase 1 pre-check doesn't fully solve; Redis-based locking; retry logic for failed bank calls |
| 4 | Redis (rate limit/cache) | Not started | Per-merchant rate limiting, caching hot reads |
| 5 | Docker + Nginx | Not started | Containerizing the app + Postgres + Redis; Nginx as reverse proxy |
| 6 | Reconciliation + Polish | Not started | Batch job comparing our records against the bank's; cleanup pass |

Full detail (schema, endpoints, done-criteria per phase) lives in
`paymentGatewayPlan.pdf`; concept primers live in `docs/STUDY_GUIDE.md`.

## 3. Current architecture

**Stack:** Node.js, Express 5, PostgreSQL (`pg` library, no ORM), Redis +
BullMQ + Docker (all planned, not yet introduced — no code depends on
them yet).

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
│                              POST /, GET /:id, GET /
├── controllers/
│   └── paymentController.js  request validation, calls paymentService,
│                              shapes HTTP responses (400/404/409/201/200)
└── services/
    └── paymentService.js     all DB queries + the one multi-statement
                               transaction (createPayment)

db/schema.sql                 merchants, payments, payment_events tables
                               + indexes (see §4 for the reasoning behind
                               each table)
docs/STUDY_GUIDE.md           concept primers (middleware, pooling,
                               parameterized queries, transactions,
                               DECIMAL vs FLOAT, idempotency, CHECK
                               constraints)
DECISIONS.md                  14 logged decisions, Reasoning/Tradeoff
                               columns still blank (see §5)
```

**How it connects:** a request hits `requestLogger` → Express's JSON
parser → `/payments` router → `auth` middleware (attaches `req.merchant`)
→ controller (validates input, shapes response) → service (owns all SQL)
→ Postgres via a pooled connection. Any thrown/rejected error from an
async handler anywhere in that chain falls through to `errorHandler.js`
automatically (Express 5 behavior — no manual `try/catch` scattered
through routes).

## 4. Key design decisions made so far

All 14 are logged with full context in `DECISIONS.md`; the headline ones:

- **UUID primary keys**, not `SERIAL` — avoids leaking sequential/guessable
  IDs across merchants.
- **`DECIMAL(12,2)` for `amount`**, not `FLOAT` — binary floats can't
  represent decimal money exactly (`0.1 + 0.2 !== 0.3`); a rounding error
  here is a real accounting discrepancy.
- **`UNIQUE(merchant_id, idempotency_key)`** — composite, not global,
  because two different merchants can legitimately both send an
  idempotency key like `"order_1"`.
- **`payment_events` is a separate append-only table**, not just an
  overwritten `payment_status` column — otherwise the fact a payment was
  ever `PROCESSING` is lost the moment it becomes `SUCCESS`. This table is
  what reconciliation (Phase 6) and debugging will actually read.
- **CHECK constraints at the DB level** (`positive_amount`,
  `valid_payment_status`) as defense in depth, on top of app-level
  validation — holds even if a future bug or a direct DB script bypasses
  the app.
- **Idempotency handled two ways at once**: a `SELECT` pre-check in
  `createPaymentHandler`/`findPaymentByIdempotencyKey`, *and* a catch on
  Postgres `23505` (unique violation) in `paymentService.createPayment` as
  a backstop, turning the race into a clean 409 instead of a raw 500.
  Explicitly **not** a full fix for the race — see the open question in
  §7, closed properly in Phase 3 with a Redis lock.
- **One pooled client + explicit transaction** for `createPayment` — the
  payment INSERT and its first `payment_events` INSERT must succeed or
  fail together, which requires both statements on the *same* connection
  (`pool.connect()`), not two independent `pool.query()` calls that could
  land on different pooled connections.
- **API-key header auth, no sessions/JWT** — `x-api-key` looked up per
  request against `merchants`, attached to `req.merchant` once so
  downstream code never re-touches the raw key.
- **No `try/catch` in routes/controllers** — relying on Express 5's
  automatic forwarding of async errors to `errorHandler.js`.
- **`amount` returned as the raw string** `pg` gives back for `NUMERIC`
  (e.g. `"999.50"`), not cast to a JS `number` (avoids reintroducing float
  imprecision on the way out).
- **`LIMIT`/`OFFSET` pagination**, not cursor-based, for `GET /payments`.
- **No `currency` column yet** — hardcoded to INR, deferred rather than
  adding a column defaulted to `'INR'` now.
- **Speculative fields deferred** — `metadata`, `bank_reference`,
  `failure_reason`, `description`, `customer_email` were cut from an
  earlier draft; they'll be added via `ALTER TABLE` when a later phase
  actually needs them.
- **No manual index on `(merchant_id, idempotency_key)`** — the `UNIQUE`
  constraint already creates one; a second would just be duplicate
  overhead.

## 5. What's in progress right now

Phase 1's *code* is functionally complete: schema, pool, auth, all three
payment endpoints, and the double-layered idempotency check all exist and
match the plan. What's **not** finished is the actual point of this
project — understanding:

- **`DECISIONS.md`**: all 14 entries have `Reasoning:` and `Tradeoff:`
  left blank. Per the project's own rule ("if you can't fill in Reasoning
  and Tradeoff from memory, you don't understand the decision yet"),
  Phase 1 is not actually "done" until these are filled in from
  understanding, not copy-pasted from this file.
- **The Study Guide's "questions to be ready to answer after Phase 1"**
  (in `docs/STUDY_GUIDE.md`) haven't been explicitly gone through:
  - Why does `auth.js` attach `merchant` to `req` instead of passing the
    API key down to every function that needs it?
  - What actually happens if two requests with the same idempotency key
    arrive at the exact same millisecond? (Phase 1's DB constraint alone
    doesn't fully solve this.)
  - Why is `payment_events` separate instead of overwriting `status` in
    place?
- Last commit message ("done with the first phase almost, left for
  review what is left") confirms this matches where things actually
  stand — code-complete, review/understanding pass pending.

## 6. Next 2-3 concrete steps

1. Go through `DECISIONS.md` entry by entry and fill in Reasoning/Tradeoff
   from memory (not by re-reading the code) — this is the actual Phase 1
   completion gate, not the code itself.
2. Answer the three Study Guide questions out loud/in writing before
   calling Phase 1 done.
3. Only after both of those: start Phase 2 (Fake Bank + Lifecycle) — do
   not start writing Phase 2 code before that review, per the standing
   "never write the next phase's code unprompted" rule.

## 7. Open questions / known issues

- **Idempotency race condition is not fully closed.** The `SELECT`
  pre-check + `23505` catch prevents a duplicate *row*, but doesn't
  prevent two near-simultaneous requests from both doing real work before
  one gets rejected. Phase 3's Redis lock is the actual fix — flagged in
  both `DECISIONS.md` #010 and `paymentService.js` comments, not a bug,
  a known deferred item.
- **No tests exist yet** (`package.json` test script is the default
  placeholder). Not yet decided which testing approach/library to use —
  per CLAUDE.md's standing rule, that should be presented as options with
  tradeoffs when it comes up, not decided unilaterally.
- **`src/middleware/.cph/` directory**: earlier session flagged a stray
  `.cph/.requestLogger.js_*.prob` file (Competitive Programming Helper
  VS Code extension artifact, not project source) that had gotten
  git-staged. Confirm it's excluded going forward (check `.gitignore`)
  rather than accidentally re-staging it in a future commit.
