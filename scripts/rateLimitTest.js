// Checks the per-merchant rate limiter: uses up exactly the remaining
// allowance for this minute, then expects the very next request to get 429.
//
//   API_KEY=<merchant key> node scripts/rateLimitTest.js
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('API_KEY env var is required');
  process.exit(1);
}

const hit = () => fetch(`${GATEWAY}/payments?limit=1`, { headers: { 'x-api-key': API_KEY } });

async function main() {
  const first = await hit();
  if (first.status === 429) {
    console.error('already rate limited -- wait a minute and rerun');
    process.exit(1);
  }
  const limit = Number(first.headers.get('x-ratelimit-limit'));
  const remaining = Number(first.headers.get('x-ratelimit-remaining'));
  console.log(`limit=${limit}/min, remaining after first request=${remaining}`);

  // fire the rest of the allowance concurrently -- the Lua script must not
  // let two simultaneous requests both slip in as "the 100th"
  const burst = await Promise.all(Array.from({ length: remaining }, hit));
  const burstLimited = burst.filter((r) => r.status === 429).length;

  const over = await hit();
  const ok = burstLimited === 0 && over.status === 429;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${remaining} concurrent requests all allowed (${burstLimited} limited), `
    + `request #${limit + 1} -> ${over.status} (Retry-After: ${over.headers.get('retry-after')}s)`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
