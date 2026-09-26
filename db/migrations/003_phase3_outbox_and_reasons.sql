-- Phase 3: webhook outbox, event reasons, webhook signing secret.
-- Safe to run more than once (IF NOT EXISTS everywhere).

-- Why a transition happened, not just that it did: 'bank_timeout',
-- 'bank_unreachable', 'resolved_by_bank_lookup', 'stale_processing', ...
-- Phase 2 got away without it because every transition had exactly one
-- cause. The resolution job adds a second path into the same states.
ALTER TABLE payment_events
    ADD COLUMN IF NOT EXISTS reason TEXT;

-- HMAC key for signing webhooks, so a merchant can verify a delivery
-- really came from us and wasn't forged by anyone who knows their URL.
ALTER TABLE merchants
    ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL
        DEFAULT encode(gen_random_bytes(32), 'hex');

-- Transactional outbox. A row is inserted in the SAME transaction that
-- moves a payment to SUCCESS/FAILED, so "payment reached a terminal state"
-- and "merchant must be told" can never disagree. Delivery itself happens
-- later, from the worker, with retries.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID NOT NULL REFERENCES payments(id),
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    payment_status  TEXT NOT NULL,   -- the terminal status this delivery announces
    payload         JSONB NOT NULL,  -- snapshot taken at transition time
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    attempts        INT  NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    delivered_at    TIMESTAMP,

    CONSTRAINT valid_delivery_status CHECK (
        delivery_status IN ('pending', 'delivered', 'dead_letter')
    ),
    -- one announcement per terminal transition, even if two resolvers race
    CONSTRAINT uq_delivery_per_transition UNIQUE (payment_id, payment_status)
);

-- the outbox sweeper's query: "pending rows older than N seconds"
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
    ON webhook_deliveries(delivery_status, created_at);
