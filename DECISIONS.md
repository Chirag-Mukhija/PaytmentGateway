# Architectural Decisions

Fill each entry in as we make the decision — Decision / Reasoning / Tradeoff.
If you can't fill in Reasoning and Tradeoff from memory, you don't understand
the decision yet.

## 001 — UUID over SERIAL for primary keys
Date: 2026-09-09
Decision: `id` columns on `merchants` and `payments` are `UUID DEFAULT gen_random_uuid()`, not `SERIAL`.
Reasoning:
Tradeoff:

## 002 — DECIMAL(12,2) over FLOAT for amount
Date: 2026-09-09
Decision: `payments.amount` is `DECIMAL(12,2)`, not `FLOAT`/`REAL`.
Reasoning:
Tradeoff:

## 003 — Idempotency key unique per merchant, not globally
Date: 2026-09-09
Decision: `UNIQUE(merchant_id, idempotency_key)` as a composite constraint, instead of `idempotency_key` alone being unique.
Reasoning:
Tradeoff:

## 004 — Separate payment_events table instead of overwriting status in place
Date: 2026-09-09
Decision: status transitions get their own append-only `payment_events` table rather than only updating `payments.payment_status`.
Reasoning:
Tradeoff:

## 005 — CHECK constraints enforced at the database level
Date: 2026-09-09
Decision: `positive_amount` and `valid_payment_status` are DB-level `CHECK` constraints, not just validated in application code.
Reasoning:
Tradeoff:

## 006 — No currency column yet, hardcoded to INR
Date: 2026-09-09
Decision: left `currency` out of the schema entirely for now instead of adding a column defaulted to `'INR'`.
Reasoning:
Tradeoff:

## 007 — Deferred speculative payment fields instead of pre-adding them
Date: 2026-09-09
Decision: `metadata`, `bank_reference`, `failure_reason`, `description`, `customer_email` were all removed from an earlier draft — they'll get added via `ALTER TABLE` when a later phase actually needs them, not built in now.
Reasoning:
Tradeoff:

## 008 — No manual index on (merchant_id, idempotency_key)
Date: 2026-09-09
Decision: relying on the index Postgres auto-creates for the `UNIQUE` constraint (decision 003) instead of also adding an explicit `CREATE INDEX` on the same columns.
Reasoning:
Tradeoff:

## 009 — One pooled client + explicit transaction for payment creation
Date: 2026-09-09
Decision: `createPayment` checks out a single client via `pool.connect()` and wraps the payment insert + its first event insert in `BEGIN`/`COMMIT`, instead of two separate `pool.query()` calls.
Reasoning:
Tradeoff:

## 010 — Idempotency handled two ways at once: pre-check plus DB backstop
Date: 2026-09-09
Decision: `POST /payments` first `SELECT`s for an existing `idempotency_key` before inserting, *and* the code separately catches Postgres error `23505` (unique violation) as a fallback, converting it to a 409 instead of a raw 500.
Reasoning:
Tradeoff:

## 011 — API key in a header, looked up per request — no sessions or JWT
Date: 2026-09-09
Decision: `auth.js` reads `x-api-key` on every request and looks the merchant up directly in the `merchants` table, instead of issuing a session or signed token after a login step.
Reasoning:
Tradeoff:

## 012 — Relying on Express 5's automatic async error forwarding
Date: 2026-09-09
Decision: no `try/catch` in the route handlers or controllers — errors thrown/rejected inside `async` functions are left to reach `errorHandler.js` on their own.
Reasoning:
Tradeoff:

## 013 — Returning `amount` as a string, not casting to a JS number
Date: 2026-09-09
Decision: the API response for `amount` is whatever string `pg` returns for the `NUMERIC` column (e.g. `"999.50"`), left uncast.
Reasoning:
Tradeoff:

## 014 — LIMIT/OFFSET pagination instead of cursor-based
Date: 2026-09-09
Decision: `GET /payments` paginates with `LIMIT`/`OFFSET` query params, not a cursor (e.g. "give me items after this ID").
Reasoning:
Tradeoff:
