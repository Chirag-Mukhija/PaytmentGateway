-- Phase 2: the bank now exists, so payments needs somewhere to record
-- what it said. Both columns were explicitly deferred in DECISIONS.md
-- #007-equivalent ("add via ALTER TABLE when a later phase needs them") --
-- this is that later phase.
ALTER TABLE payments
    ADD COLUMN bank_reference TEXT,  -- bank's own transaction id, set on SUCCESS
    ADD COLUMN failure_reason TEXT;  -- e.g. 'insufficient_funds', set on FAILED
