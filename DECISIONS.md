# Architectural Decisions

Only the decisions that trade real properties against each other live here —
things worth defending in an interview. Implementation-detail choices (which
pagination style, whether a column is cast on the way out, etc.) aren't
tracked separately; they follow naturally once the decisions below are
understood.

Each entry lists the decision, the reasoning, the tradeoff (what you give up),
and — for the bigger ones — the alternatives that were actually in
contention. This pass was written by Claude for review, not recalled from
memory: read each one critically and correct anything that doesn't hold up
before treating it as understood.

---

## 001 — PostgreSQL over a document store (e.g. MongoDB)

**Decision:** the whole system is built on Postgres, not a NoSQL/document
database.

**Alternatives considered:** MongoDB (or another document store) is the
default counter-proposal any time this comes up, because it's the other
option people reach for when starting a new backend service.

**Reasoning:** a payment system's core requirement is that a payment's
existence and its audit trail either both get written or neither does —
there is no acceptable state where a payment row exists but its first
`payment_events` row doesn't (or vice versa). That's exactly what a
relational DB's multi-statement ACID transaction guarantees (see decision
006). MongoDB does have multi-document transactions now, but they're
bolted on top of a model designed around single-document atomicity, not the
primary way you're meant to use it — reaching for them everywhere you'd
naturally reach for a Postgres transaction is fighting the tool. On top of
that, payments data is inherently relational (a merchant has many payments,
a payment has many events) and benefits directly from foreign keys and
`CHECK` constraints enforcing invariants at the DB level regardless of what
application code does.

**Tradeoff:** Postgres doesn't horizontally scale writes as easily as a
document store designed for sharding out of the box — if this needed to
handle write volume far beyond a single primary, that would eventually
become a real constraint (solvable with read replicas, partitioning, or
eventually sharding, but not free). For a project at this scale, and for a
domain where correctness matters far more than raw write throughput, that
tradeoff is the right one.

---

## 002 — Synchronous bank call in the request path (for now) — the dual-write problem, named early

**Decision:** Phase 1's `createPayment` only writes to the local DB; when
Phase 2 adds the actual bank/processor call, the plan is to call it
synchronously inside the same request, not push it onto a queue and return
immediately.

**Alternatives considered:** the async/queued alternative — accept the
payment request, write an INITIATED row, enqueue a job (e.g. BullMQ, which
is already planned for Phase 3+), and have a worker make the actual bank
call out-of-band, updating status when it hears back.

**Reasoning:** this decision is really about naming the problem before
building past it. A payment touches two independent systems — your own DB
and the bank — and nothing forces both writes to succeed or fail together
the way `BEGIN`/`COMMIT` forces `payments` + `payment_events` to (decision
006 only works *within* one Postgres connection; an HTTP call to a bank
can't be wrapped inside that transaction). Concretely: insert `INITIATED`
→ call the bank → the process dies or the network drops before the
response comes back. Your DB still says `INITIATED`. You don't know if the
bank actually charged the customer or not — the request left, but you
never got the answer. That gap (one system recorded the fact, the other's
outcome is unknown) is the dual-write problem, and it exists no matter
which order the two operations happen in. Doing the bank call synchronously
in the request path is still the simpler starting point and gives the
caller an immediate, honest answer, which matches a real payment API's UX
expectations better than "poll later to find out what happened."

**Tradeoff:** synchronous means the request is only as reliable as the
bank's response time — a slow bank makes your API slow, and a bank call
that times out (as opposed to cleanly failing) leaves you not knowing
whether the charge actually went through on their side. This is precisely
the dual-write problem flagged in the project summary as "coming in Phase
2," and the honest fix is reconciliation (Phase 6): periodically comparing
your records against the bank's to catch drift, because no amount of
clever request-path code makes two independent systems atomic. The
async/queued alternative doesn't remove this problem either — it just
moves the uncertainty window and adds its own new one (a job that's
enqueued but never processed).

---

## 003 — No ORM — raw `pg` with hand-written SQL

**Decision:** all database access goes through parameterized queries via
the `pg` library directly; nothing routes through Prisma, Sequelize,
TypeORM, or similar.

**Alternatives considered:** Prisma was the main one in mind — it's the
current default recommendation for a new Node/Postgres project.

**Reasoning:** the explicit goal of this project is to *understand* backend
engineering, not to produce a working API by the shortest path. An ORM's
main job is to hide exactly the things this project is trying to learn:
what a transaction actually requires (one connection, `BEGIN`/`COMMIT`,
see decision 006), what a race condition on a unique constraint actually
looks like at the driver level (Postgres error `23505`, see decision 007),
and what SQL is actually being sent. Writing raw SQL forces those to stay
visible instead of being abstracted into `.create()`/`.transaction()`
calls.

**Tradeoff:** more boilerplate per query, no auto-generated types from the
schema (a typo in a column name is a runtime error, not a compile-time
one), and manually-written migrations instead of an ORM's migration
tooling. For a learning project of this size that's an acceptable cost;
it would be a much harder sell on a team shipping production code under
deadline, where an ORM's guardrails and velocity usually win.

---

## 004 — Idempotency key unique per merchant, not globally

**Decision:** `UNIQUE(merchant_id, idempotency_key)` as a composite
constraint on `payments`, instead of `idempotency_key` alone being globally
unique.

**Reasoning:** an idempotency key's job is to let *one client* safely retry
*one specific request* without it being processed twice. That client is
scoped to a merchant. Two unrelated merchants independently choosing the
key `"order_1"` (a very likely collision, since it's a natural key many
clients would pick) are not the same request and must not collide with
each other — a global unique constraint would incorrectly reject the
second merchant's legitimate, unrelated payment.

**Tradeoff:** none of real substance — the composite constraint is strictly
more correct than the global one here, at the cost of a marginally larger
index key (two columns instead of one). There's no scenario where global
uniqueness would have been the right call for this data model.

---

## 005 — `payment_events` as a separate append-only table, not an overwritten status column

**Decision:** every status transition writes a new row to `payment_events`
(`from_status`, `to_status`, `created_at`); `payments.payment_status` is
also updated, but the history of *how it got there* lives in the events
table, not just the current value.

**Reasoning:** the moment `payments.payment_status` goes from `PROCESSING`
to `SUCCESS` by an in-place `UPDATE`, the fact that it was ever
`PROCESSING` — and when, and what happened in between — is gone. That
history is exactly what two things this project cares about actually need:
debugging ("why does the merchant say they never got a confirmation when
we show SUCCESS?") and reconciliation (Phase 6 — comparing our sequence of
events against the bank's to catch drift). This is a lightweight version of
event sourcing: the log of transitions is the source of truth for history,
even though `payments.payment_status` still exists as a fast-to-query
current-state cache.

**Tradeoff:** every state transition is now two writes instead of one (and
they have to be transactional together, see decision 006), and reading
"what's the current status" still goes through the denormalized
`payment_status` column rather than deriving it from the event log every
time (deriving it every time would be more "purely" event-sourced, but
needlessly slow for the common read).

---

## 006 — One pooled client + explicit transaction for payment creation

**Decision:** `createPayment` calls `pool.connect()` to check out a single
client, then wraps the `payments` INSERT and its first `payment_events`
INSERT in `BEGIN`/`COMMIT`/`ROLLBACK`, rather than making two independent
`pool.query()` calls.

**Reasoning:** `pool.query()` grabs *any* available connection from the
pool per call — two separate calls can land on two different physical
connections. A transaction is a property of a single connection/session;
`BEGIN` on connection A has no effect on a statement that happens to run on
connection B. Since decision 005 requires the payment row and its first
event row to succeed or fail together, both statements must run on the
exact same client, which is why this has to be the more verbose
`pool.connect()` / `client.query()` / `client.release()` pattern instead of
the simpler `pool.query()` shorthand used everywhere else in the codebase.

**Tradeoff:** manual connection lifecycle management — the client must be
released in a `finally` block no matter what happens, or it leaks out of
the pool permanently (a real, easy-to-introduce bug if the `try/finally`
structure isn't kept intact). It's also more code than the equivalent ORM
`prisma.$transaction([...])` call would be (see decision 003).

---

## 007 — Idempotency handled two ways at once: pre-check plus DB backstop

**Decision:** `POST /payments` first runs `findPaymentByIdempotencyKey`
(a `SELECT`) before inserting, *and* separately catches Postgres error
`23505` (unique violation) in `createPayment`, converting it to a 409
instead of letting it surface as a raw 500.

**Reasoning:** the `SELECT` pre-check handles the common case cheaply and
gives a fast, clean 409 for an obviously-repeated request. But it does not
close the race condition: two requests with the same idempotency key
arriving close enough together can both pass the `SELECT` (because neither
has committed yet) and both attempt the INSERT. The `UNIQUE(merchant_id,
idempotency_key)` constraint from decision 004 is what actually prevents
the second row from ever existing — the `23505` catch is just there so
that guaranteed rejection comes back as a clean 409 instead of an unhandled
exception reaching `errorHandler.js` as a 500.

**Tradeoff:** this is explicitly *not* a full fix for the race — it
guarantees no duplicate row gets created, but does nothing to stop both
concurrent requests from doing real, possibly expensive work (e.g., a bank
call in Phase 2) before one of them gets rejected at the DB layer. Closing
that fully needs a lock held before any work starts (a Redis-based
distributed lock, planned for Phase 3) so the second request never begins
processing at all instead of being cleaned up after the fact.

---

## 008 — API key in a request header, looked up per request — no sessions or JWT

**Decision:** `auth.js` reads `x-api-key` on every request and looks the
merchant up directly against the `merchants` table each time, instead of
issuing a session cookie or a signed token (JWT) after a login step.

**Alternatives considered:** JWT-based auth (issue a signed token once,
verify its signature on subsequent requests without hitting the DB).

**Reasoning:** this is server-to-server merchant authentication, not a
human logging into a browser session — there's no login flow, no "user,"
and no UI to redirect after auth. A merchant's API key is a long-lived
credential they configure once in their backend and send on every request,
which is exactly how most payment-provider APIs authenticate merchants
(comparable to Stripe's secret-key-in-header model). A DB lookup per
request also means a compromised or revoked key can be shut off
immediately by deleting/rotating the row — a signed JWT would keep being
valid until it expires, whatever the expiry window is, unless a revocation
list is built on top of it (which reintroduces a per-request state check
anyway, undoing JWT's main appeal).

**Tradeoff:** a DB round-trip on every single request instead of a
stateless signature check — this is the cost that's explicitly deferred to
Phase 4's caching layer (Redis) rather than solved now. At current scale
that round-trip is cheap; it becomes a real cost only at higher request
volume, which is exactly when the planned cache would be introduced.
*(Done in Phase 4 — see 016, which also gives back part of the "revoked
immediately" property above, by design.)*

---

## 009 — DECIMAL(12,2) over FLOAT for `amount`

**Decision:** `payments.amount` is `DECIMAL(12,2)`, not `FLOAT`/`REAL`.

**Reasoning:** `FLOAT`/`REAL` are binary floating-point types — they cannot
represent most decimal fractions exactly (the classic `0.1 + 0.2 !==
0.3` problem), because those decimal values don't have exact binary
representations. For money, that's not a rounding curiosity, it's a real
accounting discrepancy: summed across enough transactions, the drift
becomes visible and reconciliation (Phase 6) would be comparing against a
number that was never exactly right in the first place. `DECIMAL(12,2)` is
an exact fixed-point type — no representation error, and `(12,2)` caps it
at 10 integer digits and exactly 2 decimal places, which is enough range
for real payment amounts while enforcing money's natural precision at the
schema level.

**Tradeoff:** `DECIMAL` arithmetic is slower than native floating-point
math and, in JavaScript, `pg` returns it as a string rather than a `number`
(decision cut from the trimmed list, but the consequence is real) —
meaning any arithmetic on it in application code has to go through a
decimal-safe library rather than native `+`/`-`, or it reintroduces the
exact problem this decision avoids.

---

## 010 — PROCESSING committed before the bank call; the bank call itself holds no pooled connection

**Decision:** `processPayment` writes and commits `PROCESSING` in one short
transaction, releases that connection, *then* calls the fake bank with no
DB connection held at all, then opens a second, separate transaction to
record the bank's outcome.

**Reasoning:** two separate constraints, both real:
1. *Never call the bank while still `INITIATED`.* If the process crashes
   between the bank call and the DB write, the DB must already say
   `PROCESSING` — a truthful "this was in flight, go check" — rather than
   still showing `INITIATED`, which would look safe to retry and risk a
   second real charge.
2. *A transaction should be held for milliseconds, not seconds.* The bank
   call can take up to the full timeout (10s here) — holding one of the
   pool's 20 connections open that whole time, for every in-flight
   payment, would exhaust the pool under any real concurrent load. So the
   bank call happens with the connection already returned to the pool, and
   a fresh connection is only checked out again once there's an actual
   outcome to write.

**Tradeoff:** there are now two separate commits instead of one, with a
real gap between them where the payment sits in `PROCESSING` and nothing
guarantees the second write happens (a crash in that gap is exactly what
Phase 3's PENDING-resolution job and Phase 6's reconciliation exist to
catch — this decision doesn't close the dual-write gap, it just makes sure
the DB never lies about which side of it a payment is on).

---

# Phase 3 — Idempotency + Retry

## 011 — Idempotency: the DB constraint is the guarantee, the Redis lock is the optimisation

**Decision:** `POST /payments` takes a Redis lock on `(merchant_id,
idempotency_key)` before creating (`SET key token NX EX 10`), released
with a Lua compare-and-delete that only removes the lock if it still holds
this request's token. If Redis is unreachable, the lock step is skipped and
the request proceeds (fail-open). There is **no** Redis copy of the
idempotency *result* — the `payments` row is the only record that a key
was used. Reusing a key with a different amount returns 422.

**Alternatives considered:**
- *The plan's version:* lock value `'locked'`, released with a plain `DEL`,
  plus a 24h Redis `idempotency_result` cache.
- *Fail-closed:* return 503 whenever Redis is down.
- *Postgres-only locking* (`pg_advisory_xact_lock` on a hash of the key).

**Reasoning:** the `UNIQUE(merchant_id, idempotency_key)` constraint
(decision 004) already makes a duplicate *row* impossible — Redis can't
improve on that. What the lock adds is a better answer for the concurrent
duplicate: a clean `409 in progress` with `Retry-After` instead of racing
into the INSERT and getting rejected by the constraint. Because the
constraint is the real guarantee, failing open when Redis is down costs
nothing in correctness, while failing closed would turn a cache outage into
a payments outage. The token + Lua release fixes a real bug in the plain
`DEL` version: if a request outlives the TTL, its lock expires, a second
request acquires it, and the first request's `DEL` then releases the
*second* request's lock. The result cache was dropped because the DB lookup
it would replace is already a single indexed read on the source of truth —
a second copy in Redis is one more thing to keep consistent, for no
measurable gain at this scale. Same-key-different-amount is rejected rather
than replayed because silently returning the original payment would hide a
client bug where two different checkouts share a key (Stripe does the same).

**Tradeoff:** the lock is per-Redis-instance, not a distributed consensus
lock (no Redlock) — fine because it only needs to be *usually* right; the
constraint catches the rest. Fail-open means that during a Redis outage a
concurrent duplicate gets a 409 from the constraint instead of the nicer
lock message. Advisory locks would have removed the Redis dependency
entirely, but tie the lock to a held DB connection — exactly the resource
decision 010 is careful not to hold longer than necessary.

---

## 012 — Transactional outbox for webhooks

**Decision:** when a payment reaches `SUCCESS` or `FAILED`, a row is
inserted into `webhook_deliveries` **inside the same transaction** as the
status change. After that transaction commits, the request tries to enqueue
a BullMQ job for it (fast path). A sweeper in the worker re-enqueues any
row still `pending` after 30s that has no job — so delivery doesn't depend
on the fast path succeeding.

**Alternatives considered:**
- *Enqueue after COMMIT* (the plan's Phase 3 approach): commit the status,
  then `queue.add()`.
- *Enqueue before/inside the transaction:* `queue.add()` then COMMIT.
- *Change data capture* (tail Postgres's WAL with Debezium or logical
  replication and turn status changes into events).

**Reasoning:** "payment reached a terminal state" (Postgres) and "merchant
must be told" (Redis queue) is a second dual-write problem, the same shape
as decision 002's DB-vs-bank gap. Enqueue-after-commit loses the webhook
forever if the process dies between COMMIT and `add()`, or if Redis is down
at that instant. Enqueue-before-commit is worse: a rolled-back transaction
leaves a job announcing a status change that never happened. The outbox
turns the two writes into one: the outbox row commits atomically with the
status, and "get it into the queue" becomes a retryable step that can be
repeated until it works. Enqueueing twice is harmless because the job id
*is* the outbox row id, so BullMQ ignores the duplicate. CDC solves the
same problem more generally but needs a whole extra piece of
infrastructure; a table plus a sweeper is the same guarantee at this scale.

**Tradeoff:** a webhook can arrive up to one sweep interval late if the
fast path failed. The outbox table grows forever and would eventually need
archiving. And it only moves the problem to "at least once" — see 013.

---

## 013 — Webhook delivery contract: at-least-once, signed, retried with backoff, dead-lettered

**Decision:** each outbox row is delivered by a BullMQ worker: 5 attempts,
exponential backoff (2s, 4s, 8s, 16s), 5s timeout per attempt, any non-2xx
is a failure. After the last attempt the row is marked `dead_letter` with
the last error. Every delivery carries `X-Webhook-Id` (stable across
retries) and `X-Webhook-Signature: t=<unix>,v1=<HMAC-SHA256(secret,
"t.body")>` using a per-merchant `webhook_secret`. The outbox row, not the
BullMQ job, is the record of what happened.

**Alternatives considered:**
- *In-process retries* (`setTimeout` loops inside the API server).
- *A DB-polling retrier* (cron job that retries failed rows, no Redis).
- *A heavier broker* (RabbitMQ / Kafka) instead of BullMQ.
- *Trying for exactly-once delivery.*

**Reasoning:** in-process retries die with the process and compete with
live traffic for the event loop; BullMQ gives persistence, backoff and
failed-job tracking, on Redis that was already in the plan. Exactly-once
delivery over HTTP is impossible: if the merchant processes the webhook and
the connection drops before we see their 200, we cannot know it arrived,
so we must send it again. The honest contract is at-least-once plus a
stable id the merchant dedupes on (merchant-mock demonstrates this).
Exponential backoff gives a briefly-down merchant a fast recovery without
hammering one that's down for minutes. Signing exists because the
merchant's webhook URL is not a secret — without a signature anyone could
POST "payment succeeded" to it; the timestamp inside the signature lets
the merchant reject replayed old deliveries.

**Tradeoff:** merchants *must* implement dedupe or they will occasionally
double-process. Dead-lettered rows need a human (there is no replay
endpoint yet — noted as future work). BullMQ is a much smaller operational
surface than Kafka, but it is also only as durable as the Redis
persistence behind it (see Phase 5's `appendonly` setting) — which is
exactly why the outbox row is the source of truth, not the job.

---

## 014 — PENDING is resolved by asking the bank, never by re-sending the charge

**Decision:** any time the gateway doesn't get a definitive answer from the
bank — timeout **or** connection error — the payment goes to `PENDING`
(previously a connection error returned a 500 and left the payment stuck in
`PROCESSING` forever). A worker job, every 30s:
1. moves payments stuck in `PROCESSING` for over 120s to `PENDING`
   (`reason: stale_processing`) — this is the crash-recovery path;
2. for each `PENDING` payment at least 30s old, calls the bank's
   `GET /transactions/:payment_id` and applies the answer;
3. if the bank still has no record 15 minutes after the payment went
   `PENDING`, marks it `FAILED` (`reason: bank_has_no_record`).

Every transition goes through `transitionStatus`, so if two resolvers race,
one loses cleanly with `INVALID_TRANSITION` and moves on.

**Alternatives considered:**
- *Retry the charge* on timeout.
- *Treat timeouts/connection errors as FAILED* immediately.
- *Leave stuck payments for manual intervention.*

**Reasoning:** a timeout is not evidence of anything — the bank may have
charged the card and only the response was lost. Re-sending the charge in
that state is precisely how double charges happen; looking up the outcome
never charges anyone. Marking it `FAILED` would tell the merchant a payment
failed that may actually have succeeded. The stale-`PROCESSING` sweep
exists because a crash between decision 010's two commits leaves nothing
in the request path able to finish the job — it has to be found from
outside. The give-up rule is safe because a bank with no record of a charge
after 15 minutes never received it. That relies on the bank's ledger
surviving restarts, which is why the fake bank now persists its
transactions to an append-only file and treats `/charge` as idempotent on
`payment_id`, like a real processor.

**Tradeoff:** a payment can sit in `PENDING` for up to ~1 minute (bank
answered late) or 15 minutes (bank never got it), and the merchant's
webhook waits with it. The 120s stale threshold must stay well above the
bank timeout, or the sweep would steal payments that are still
legitimately waiting on the bank.

---

## 015 — Background work runs in a separate worker process, scheduled through Redis

**Decision:** `src/worker.js` is its own process (`npm run worker`) running
the webhook worker and the maintenance jobs (PENDING resolution, outbox
sweep). The maintenance jobs are BullMQ *job schedulers* stored in Redis,
re-registered whenever the worker's Redis connection becomes ready.

**Alternatives considered:**
- *Run jobs inside the API process* with `setInterval` (the plan's sample).
- *`node-cron` or system cron.*

**Reasoning:** jobs inside the API process compete with requests for the
event loop and the DB pool, and scaling the API to N instances would run
every job N times — N resolvers working the same PENDING payments at once.
A Redis-backed scheduler produces one run per interval however many worker
processes exist, and the processes can be scaled and restarted
independently of the API. Re-registering on every reconnect covers a Redis
restart without persistence, which would otherwise delete the schedulers
and silently stop all background recovery (found while testing a Redis
outage).

**Tradeoff:** one more process to run and monitor — and if the worker is
down, the API keeps accepting payments while webhooks and PENDING
resolution quietly pile up. That's the reason Phase 5's `/health` reports
queue depth, not just "the API is up".

---

# Phase 4 — Rate limiting, caching, metrics

## 016 — Cache the API-key → merchant lookup for 30 seconds

**Decision:** `auth.js` caches the merchant row in Redis under
`merchant_by_key:<sha256(api_key)>` for 30s (`MERCHANT_CACHE_TTL_SECONDS`).
Unknown keys are never cached. Redis errors fall through to the DB.

**Alternatives considered:**
- *Keep the per-request DB lookup* (decision 008 as it was).
- *In-process memory cache* in each API instance.
- *Long TTL + explicit invalidation* when a key is rotated.

**Reasoning:** every request on every route pays for authentication, so
it's the hottest query in the system and the one decision 008 explicitly
deferred to this phase. Redis rather than process memory so all API
instances share one cache and a key rotation only has to be forgotten in one
place. The cache key is a hash so that anyone with Redis access can't list
every merchant's API key with `KEYS *`. Misses aren't cached because
caching "this key is invalid" lets anyone flood Redis with junk entries by
sending random keys.

**Tradeoff:** this deliberately gives back part of decision 008's
reasoning — a revoked or rotated key now keeps working for up to 30s. The
TTL *is* the revocation delay, and it's a knob: shorter = safer and more DB
load. Explicit invalidation would remove the delay, but there's no key
rotation endpoint yet to hook it to, so a short TTL is the honest version.
Brute-forcing invalid keys still hits the DB every time — that's handled
at the edge by Nginx's per-IP limit in Phase 5, not here.

---

## 017 — Per-merchant rate limit: sliding-window log in one Lua script, failing open

**Decision:** 100 requests per rolling 60 seconds per merchant
(`RATE_LIMIT_PER_MINUTE`), applied to every `/payments` route after auth.
Implemented as a Redis sorted set of accepted-request timestamps, with
trim → count → conditional add done in a single Lua script, using Redis's
own clock (`TIME`). Returns `429` with `Retry-After`, plus
`X-RateLimit-Limit` / `X-RateLimit-Remaining` on every response. If Redis
is down, requests are allowed.

**Alternatives considered:**
- *Fixed window counter* — the plan's sample code (`INCR` a per-minute key).
- *Sliding window counter* — weight the previous minute's count by how
  much of it still overlaps the window. O(1) memory, approximate.
- *Token bucket* — steady refill rate plus a burst allowance.

**Reasoning:** the fixed window has a known hole: 100 requests at 0:59 and
100 more at 1:00 is 200 in two seconds, all allowed. The plan's done
criterion ("101 requests in one minute → 429 on the 101st") is only
reliably true with a real sliding window. The log is exact and the easiest
to reason about. It has to be one Lua script because "count, then add" as
two commands lets two concurrent requests both read 99 and both get in —
verified by firing 99 concurrent requests and getting exactly 0 rejected
and then a 429. Redis `TIME` instead of `Date.now()` because several API
instances with slightly different clocks would each see a slightly
different window. Failing open follows from what the limiter is for: it
protects capacity, it isn't a correctness guarantee, so a Redis outage
shouldn't become a payments outage (same reasoning as 011).

**Tradeoff:** the log stores one entry per accepted request, so memory per
merchant grows with the limit — fine at 100/min, wasteful at 100k/min, where
the sliding window counter would be the better choice. Rejected requests
aren't recorded, so a client hammering while limited gets back in as soon
as old entries age out, rather than being punished for the hammering. One
global limit for every merchant; per-merchant limits would need a column
on `merchants`.

---

## 018 — Cache only what can never change; metrics from the DB plus a Redis latency sample

**Decision (cache):** `GET /payments/:id` caches the payment row + its
events for 5 minutes, **only** once the payment is `SUCCESS` or `FAILED`.
Webhook delivery status is always read live. There is no cache
invalidation code anywhere. Hit/miss is reported in an `X-Cache` header,
not the body. Ownership is re-checked on cache hits.

**Decision (metrics):** `GET /metrics` (guarded by a separate
`ADMIN_TOKEN`, disabled if unset) reports volume, success rate and "stuck"
counts straight from Postgres, webhook backlog from the outbox table and
the BullMQ queue, and p50/p95/p99 latency per route (and for the bank call)
from the last 1000 samples kept in a Redis list per operation.

**Alternatives considered:**
- *Cache every payment and invalidate on each transition* (the usual
  cache-aside + invalidation pattern).
- *The plan's `_cached: true` field in the response body.*
- *Prometheus client (`prom-client`) + histograms*, scraped by Prometheus.
- *Per-process in-memory latency tracking.*

**Reasoning:** cache invalidation is where caches go wrong — every code
path that changes a payment would have to remember to delete the key, and
missing one serves stale data. A terminal payment's row and events can
never change again, so caching only those needs no invalidation at all.
Non-terminal payments are the ones a merchant polls to see a change,
exactly the ones that must never be stale. Webhook status keeps changing
after SUCCESS, so it's excluded from the cached part. `X-Cache` keeps the
response body identical either way (verified field-for-field). For
metrics, business numbers come from Postgres because they must match
reality exactly. Latency goes in Redis so the numbers cover every API
instance, not whichever one served the `/metrics` call. Keying by route
pattern (`GET /payments/:id`), not URL, keeps the key count bounded. The
bank call is measured separately because it dominates: p95 of `/process`
is ~10s, entirely because of bank timeouts. Metrics span every merchant,
so a merchant API key must not open them.

**Tradeoff:** the cache helps only reads of finished payments. A merchant
polling a PENDING payment still hits the DB every time, which is the right
call but means the cache does nothing for the busiest polling pattern. The
latency sample is the last 1000 requests, not a time window, so on a quiet
system "p95" can describe requests from hours ago. Real monitoring
(Prometheus histograms, alerting) is the production answer. This is the
learning-sized version, and it's listed as future work.

---

# Phase 5 — Docker + Nginx

## 019 — Nginx is the only way in, and it does the work that belongs at the edge

**Decision:** in `docker-compose.yml` only Nginx publishes the API port
(80). The gateway, worker, Postgres and Redis are reachable only on the
internal compose network. Nginx:
- proxies to the gateway over pooled keep-alive connections, re-resolving
  the `gateway` service name every 5s, so `--scale gateway=3` works
  without a restart;
- enforces a **per-IP** rate limit (50 r/s, burst 100) before a request
  reaches Node;
- generates a request id and forwards it as `X-Request-Id`, and writes a
  JSON access log;
- only allows `/metrics` from private networks, on top of the admin token;
- caps request bodies at 16 KB.

**Alternatives considered:**
- *Expose the gateway directly* (plan's compose publishes `3000:3000` too).
- *Do everything in Express* (IP rate limiting middleware, etc.).
- *A managed load balancer / API gateway* (what production would use).

**Reasoning:** there are two layers of protection because there are two
kinds of attacker. The gateway's own limiter (017) is per *merchant* and
only runs after a valid key, so a flood of *invalid* keys — someone
guessing API keys — sails past it and hits Postgres on every request. That
has to be stopped per *IP*, before Node: verified by sending 400 rapid
invalid-key requests, of which Nginx rejected 259 and only the burst
allowance reached the gateway. Publishing only Nginx means there's exactly
one front door to secure and log. The request id is what lets you join
Nginx's log line to the gateway's (Phase 6 logs it). Keep-alive pooling to
the upstream is the same idea as the Postgres pool, one hop earlier.
Scaling was verified: three gateway instances each served exactly a third
of 60 requests, and the full smoke test passed across them — possible only
because every piece of shared state (locks, limits, cache) lives in Redis,
not in a process.

**Tradeoff:** one more hop and one more config file to get right. DNS
re-resolution every 5s means that when a gateway container is replaced,
Nginx can send requests to the dead address for up to 5s (seen as 502s in
testing with the original 10s setting). Real deployments avoid that with
health-checked load balancing and rolling deploys. Per-IP limits punish
many users behind one NAT and can be dodged by an attacker with many IPs,
so they're a first line, not the whole defence.

---

## 020 — Liveness vs. readiness, and shutting down without dropping payments

**Decision:**
- `GET /health/live` answers "is the process up" and checks nothing else;
  it's what Docker's healthcheck uses.
- `GET /health` checks every dependency with a 2s timeout each: Postgres
  down → **503**; Redis, bank, or no live worker (heartbeat in a Redis
  sorted set) → **200 "degraded"**.
- On `SIGTERM` the gateway stops accepting connections, lets in-flight
  requests finish (up to 20s), closes idle keep-alive sockets as they free
  up, then closes the queue, pool and Redis. The worker closes BullMQ
  workers (finishing in-flight jobs) and removes its heartbeat.
- `stop_grace_period: 30s` in compose; `CMD ["node", ...]` in exec form;
  containers run as the non-root `node` user; one image serves as both
  gateway and worker.

**Alternatives considered:**
- *One `/health` that checks the DB, used by Docker too.*
- *No signal handling* (Node's default: exit immediately on SIGTERM).
- *Separate images for gateway and worker.*

**Reasoning:** if the Docker healthcheck checked Postgres, a DB outage
would make Docker restart every gateway — which fixes nothing and throws
away in-flight work. "Should traffic be routed here" and "should this
process be killed" are different questions and need different endpoints.
Only Postgres being down means payments can't work at all; everything else
was built to fail open or recover later, so reporting it as "degraded"
rather than failing the check keeps traffic flowing. Graceful shutdown
matters more here than in most apps: a `/process` request that's already
committed `PROCESSING` and is waiting on the bank must not be cut off
(decision 014 would rescue it, but minutes later). Docker's default 10s
grace equals the bank timeout, so it's raised to 30s. The shell form of
`CMD` wraps Node in `/bin/sh`, which doesn't forward SIGTERM, so the
handler would never run. Verified: `docker stop` sent 2s into a 10s bank
call waited 8.3s, the request completed with 200, and nothing was left in
`PROCESSING`. The first version took 14s — the extra 5s was Nginx's pooled
connection sitting idle until Node's keep-alive timeout, fixed by closing
idle sockets repeatedly while draining.

**Tradeoff:** deploys are slower (a gateway can take up to 20s to stop).
The worker heartbeat is a Redis write every 10s per worker. "Degraded"
still returns 200, so something has to actually *look* at the body — a
dashboard or alert, not just a load balancer.

---

## Cut from this file (implementation detail, not architecture)

For reference, these were removed from an earlier draft of this file as
too granular to be "decisions" in the sense this document tracks — they're
one-line consequences of the decisions above, not separate tradeoffs:
UUID vs SERIAL primary keys, DB-level `CHECK` constraints as defense in
depth, deferring the `currency` column, deferring speculative fields
(`metadata`, `bank_reference`, etc.), not adding a redundant manual index
on top of the UNIQUE constraint's auto-index, relying on Express 5's
automatic async error forwarding, returning `amount` as an uncast string,
and LIMIT/OFFSET vs cursor pagination.

Smaller choices from later phases, logged here rather than as full entries:
- *Staying on JavaScript* instead of the plan's optional TypeScript switch
  in Phase 3: one language across the codebase keeps the focus on the
  backend concepts; the cost is no compile-time checking of column names.
- *Native `fetch` + `AbortController`* instead of `axios` for the bank and
  webhook calls: no extra dependency, and the timeout mechanism is visible.
- *Migrations are plain numbered SQL files* using `IF NOT EXISTS`, so each
  one runs safely against both a fresh DB and an older one. No migration
  tool — there are few enough to run by hand.
- *Amount validation* rejects more than 2 decimal places and anything over
  `DECIMAL(12,2)`'s max, so Postgres never silently rounds a value that a
  later idempotent replay would then fail to match.
- *Redis runs with `appendonly yes`* in compose: BullMQ jobs, delayed
  retries and schedulers live in Redis, so it's persisted even though the
  outbox (012) means correctness doesn't depend on it.
- *A dev seed with fixed, public credentials* (`db/seed.sql`) loads on the
  first start of an empty Postgres volume, so the stack is usable with one
  command. Clearly marked never-for-production.
- *The fake bank's ledger is a named volume*, so the bank's memory of what
  it charged survives `docker compose down` like a real bank's would.
