# Study Guide — Read During Downtime

Two parts: (1) how to use Claude Code well for *this specific* project,
(2) the concepts Phase 1 assumes you understand. Nothing here is Phase 1
code — that we write together, interactively, when you're back.

---

## Part 1 — Using Claude Code on a learning project

Your CLAUDE.md already tells me: explain WHY before code, point out what
breaks at scale, ask what your attempt is before I write anything. That's
the right instinct for a project whose goal is comprehension, not output.
A few things that follow from that, on your side:

- **This is not a "cowork"/delegate-and-walk-away project.** Claude Code
  can run autonomous background agents that write whole features while
  you're away. Don't use that here — the entire value of this project is
  you writing the line, getting it wrong, and understanding why. Save
  autonomous/background delegation for throwaway scaffolding (e.g. "spin
  up a boilerplate repo") on projects where the *artifact* is the point,
  not the *understanding*.
- **Small, focused sessions save usage.** Don't open one giant session
  spanning all 6 phases — start a session per phase (or per sub-feature).
  Long conversations re-send more history on every turn.
- **Be specific in prompts.** "Write the auth middleware" costs a
  back-and-forth to clarify. "Here's my attempt at auth.js, it 401s even
  with a valid key, here's why I think that's happening" gets a direct,
  cheap answer.
- **You review every line before it runs.** Since you're not typing the
  keystrokes, the reading *is* your rep. Don't accept a diff you can't
  explain back.
- **DECISIONS.md is your forcing function.** If you can't fill in
  "Reasoning" and "Tradeoff" for a decision, you don't understand it yet
  — ask before moving on, don't paste in something you can't defend in
  an interview.
- **When you don't know which option to pick**, say so — I'll lay out
  2-3 options with tradeoffs and you choose. That's now written into
  CLAUDE.md as a standing rule.

---

## Part 2 — Concepts Phase 1 assumes

Skim these before we write code so the first session is "apply this"
rather than "learn this from scratch." You don't need mastery, just the
shape of each idea — we'll go deep when you hit each one for real.

### Express middleware pipeline
Every request flows through an ordered chain of functions before hitting
your route handler: logger → auth → route → error handler. Each
middleware either calls `next()` to pass control forward or ends the
response. Order matters — auth must run before the route logic, error
handling must be registered last so it catches everything above it.

### Connection pooling (`Pool` vs `Client`)
A single Postgres connection is expensive to open (TCP handshake + auth)
and can only run one query at a time. A `Pool` keeps a set of open
connections and hands one out per query, reusing them. Opening a new
`Client` per request works for a demo and falls over the moment two
requests arrive at once — this is one of the first things that "breaks
at scale" in a naive implementation.

### Parameterized queries (`$1`, `$2`, ...)
```
// dangerous — string concatenation
`SELECT * FROM payments WHERE id = '${id}'`

// safe — parameterized
'SELECT * FROM payments WHERE id = $1', [id]
```
If `id` comes from user input and you concatenate it into the SQL
string, a malicious value can change the query's meaning entirely (SQL
injection). Parameterized queries send the value separately from the
query structure, so it's always treated as data, never as code.

### Transactions (`BEGIN` / `COMMIT` / `ROLLBACK`)
A transaction groups multiple statements so they succeed or fail as one
unit. For payments this matters because "update payment status" and
"insert an audit event" must both happen or neither should — a partial
write leaves your data in a state you can't trust.

### `DECIMAL` vs `FLOAT` for money
Floats store approximations of decimal numbers in binary — `0.1 + 0.2`
famously doesn't equal `0.3`. For money, a rounding error like that is a
real accounting discrepancy, not a cosmetic bug. `DECIMAL(12,2)` stores
exact base-10 values instead.

### Idempotency keys
Networks are unreliable — a client can send the same "charge $10"
request twice because the first response got lost, not because they
want to pay twice. An idempotency key lets the server recognize "I've
seen this exact request before" and return the original result instead
of creating a second payment. This is the concept that later becomes
the "one route we exploit" — Phase 3 will show you the failure mode
where a naive implementation still double-processes under concurrency.

### API key auth middleware
Every request identifies which merchant is calling via a header
(`x-api-key`). Middleware looks the key up once, attaches the merchant
to the request object, and every downstream handler trusts
`req.merchant` instead of re-checking. This is also a security boundary:
a merchant must never be able to read another merchant's payments.

### `CHECK` constraints as defense in depth
Your application code enforcing "amount must be positive" is good; the
database also enforcing it via a `CHECK` constraint is a second layer
that holds even if a future bug, a bad migration, or a direct DB script
bypasses your app code.

---

## Questions to be ready to answer after Phase 1
(Ask yourself these before we call it done — if you can't answer one,
that's the thing to dig into, not skip.)

- Why does the auth middleware attach `merchant` to `req` instead of
  passing the API key down to every function that needs it?
- What actually happens if two requests with the same idempotency key
  arrive at the exact same millisecond? (Phase 1's DB constraint alone
  doesn't fully solve this — you'll see why in Phase 3.)
- Why is the payment's audit trail (`payment_events`) a separate table
  instead of just overwriting `status` on the `payments` row?
