-- Phase 2: the bank now exists, so payments needs somewhere to record
-- what it said. Both columns were deliberately deferred in Phase 1
-- ("add via ALTER TABLE when a later phase needs them") -- this is that
-- later phase.
--
-- IF NOT EXISTS makes this safe to run against a DB that was created from
-- the current schema.sql (which already has these columns) as well as an
-- older one that doesn't.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS bank_reference TEXT,  -- bank's own transaction id, set on SUCCESS
    ADD COLUMN IF NOT EXISTS failure_reason TEXT;  -- e.g. 'insufficient_funds', set on FAILED
