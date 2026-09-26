-- Phase 6: timestamps with time zone, and reconciliation reports.
-- Safe to run more than once.

-- Every timestamp column was TIMESTAMP (no time zone): NOW() stored the
-- Postgres server's local wall-clock time, and node-pg parsed it back in
-- the Node process's local zone. Correct only while both happen to share
-- a zone. Reconciliation works on exact UTC day boundaries, so the columns
-- become TIMESTAMPTZ: an absolute instant, converted correctly by every
-- client. Existing values are interpreted in the server's zone, which is
-- how NOW() wrote them. (Converting an already-TIMESTAMPTZ column is a
-- no-op, which keeps this re-runnable.)
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
      AND table_name IN ('merchants', 'payments', 'payment_events', 'webhook_deliveries')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE current_setting(''TimeZone'')',
      col.table_name, col.column_name, col.column_name
    );
  END LOOP;
END $$;

-- One report per UTC day. Re-running reconciliation for a day replaces
-- that day's report instead of adding a second one.
CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_date   DATE NOT NULL UNIQUE,
    summary       JSONB NOT NULL,
    discrepancies JSONB NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- reconciliation's gateway-side query: "what reached SUCCESS on day D"
CREATE INDEX IF NOT EXISTS idx_events_to_status_created
    ON payment_events(to_status, created_at);
