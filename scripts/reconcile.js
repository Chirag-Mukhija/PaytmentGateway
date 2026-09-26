// Run reconciliation for one UTC day by hand and print the report.
//
//   node scripts/reconcile.js              # yesterday (UTC)
//   node scripts/reconcile.js 2026-09-26   # a specific day
//
// Needs DATABASE_URL and FAKE_BANK_URL (reads .env). Same code the worker
// runs daily; the report is also stored in reconciliation_reports.
require('dotenv').config({ quiet: true });
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const pool = require('../src/config/db');
const { runReconciliation, yesterdayUTC } = require('../src/jobs/reconciliationJob');

async function main() {
  const date = process.argv[2] || yesterdayUTC();
  const { summary, discrepancies } = await runReconciliation(date);
  console.log(JSON.stringify(summary, null, 2));
  for (const d of discrepancies) {
    console.log(`${d.severity.toUpperCase().padEnd(8)} ${d.type.padEnd(18)} ${d.payment_id}  ${d.detail || ''}`);
  }
  await pool.end();
  process.exit(summary.critical ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
