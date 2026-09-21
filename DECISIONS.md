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
