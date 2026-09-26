-- needed for gen_random_uuid() / gen_random_bytes() below
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- merchants: businesses integrating with the gateway.
-- no users table -- the person paying is the merchant's customer,
-- not an account in our system.
CREATE TABLE merchants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,

    -- auth is just this key in an x-api-key header, no login/session
    api_key     TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),

    webhook_url TEXT, -- nullable, merchant might not have set one up yet

    -- HMAC key for signing webhook deliveries (Phase 3)
    webhook_secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),

    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- payments: one row per payment attempt a merchant asked us to process
CREATE TABLE payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id      UUID NOT NULL REFERENCES merchants(id),

    -- client-supplied, identifies "this one checkout attempt" so a
    -- retried request doesn't double-charge
    idempotency_key  TEXT NOT NULL,

    amount           DECIMAL(12,2) NOT NULL, -- DECIMAL not FLOAT: no rounding error on money
    -- no currency column yet, hardcoding INR (logged in DECISIONS.md)

    payment_status   TEXT NOT NULL DEFAULT 'INITIATED',

    -- both nullable: only set once the bank actually responds (Phase 2).
    -- deferred out of Phase 1 on purpose (see DECISIONS.md), added now
    -- that there's a bank call whose outcome needs recording.
    bank_reference   TEXT,
    failure_reason   TEXT,

    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_payment_status CHECK (
        payment_status IN ('INITIATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'PENDING')
    ),
    CONSTRAINT positive_amount CHECK (amount > 0),

    -- unique per merchant, not globally -- two merchants can both use "order_1"
    CONSTRAINT uq_merchant_idempotency UNIQUE (merchant_id, idempotency_key)
);

-- payment_events: append-only history of status changes.
-- payments.payment_status only holds the *current* state -- overwrite it
-- in place and you lose the fact a payment was ever PROCESSING. this
-- table is what reconciliation and debugging actually look at later.
CREATE TABLE payment_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id  UUID NOT NULL REFERENCES payments(id),
    from_status TEXT, -- null on the first event (nothing -> INITIATED)
    to_status   TEXT NOT NULL,
    reason      TEXT, -- why it happened: 'bank_timeout', 'resolved_by_bank_lookup', ... (Phase 3)
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- webhook_deliveries: transactional outbox (Phase 3). A row is inserted in
-- the same transaction that moves a payment to SUCCESS/FAILED; the worker
-- delivers it later with retries. See DECISIONS.md.
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID NOT NULL REFERENCES payments(id),
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    payment_status  TEXT NOT NULL,
    payload         JSONB NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    attempts        INT  NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,

    CONSTRAINT valid_delivery_status CHECK (
        delivery_status IN ('pending', 'delivered', 'dead_letter')
    ),
    CONSTRAINT uq_delivery_per_transition UNIQUE (payment_id, payment_status)
);

-- indexes: match the actual queries, don't index just to index
CREATE INDEX idx_payments_merchant ON payments(merchant_id, created_at DESC); -- GET /payments listing
CREATE INDEX idx_payments_status ON payments(payment_status);                -- Phase 3 pending-scanner
CREATE INDEX idx_events_payment ON payment_events(payment_id);               -- GET /payments/:id history
CREATE INDEX idx_webhook_deliveries_pending
    ON webhook_deliveries(delivery_status, created_at);                       -- outbox sweeper (Phase 3)

-- no index on (merchant_id, idempotency_key) -- the UNIQUE constraint
-- above already creates one automatically, a second would be duplicate
-- overhead

-- reconciliation_reports: one per UTC day (Phase 6). Re-running a day
-- replaces its report. See src/jobs/reconciliationJob.js.
CREATE TABLE reconciliation_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date   DATE NOT NULL UNIQUE,
    summary       JSONB NOT NULL,
    discrepancies JSONB NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_to_status_created
    ON payment_events(to_status, created_at);                                 -- reconciliation (Phase 6)
