# Payment Gateway — CLAUDE.md

## Project context
Learning project. Student building payment gateway to understand
backend engineering deeply. Goal is comprehension, not just working code.

## Stack
Node.js, Express, PostgreSQL (pg library), Redis, BullMQ, Docker

## Current phase
Phase 1 — Foundation

## Roadmap
Full 6-phase plan (with schema, endpoints, and done-criteria for each phase)
lives in `paymentGatewayPlan.pdf` and is summarized in `docs/STUDY_GUIDE.md`.
Phase order: 1 Foundation → 2 Fake Bank + Lifecycle → 3 Idempotency + Retry
→ 4 Redis (rate limit/cache) → 5 Docker + Nginx → 6 Reconciliation + Polish.

## Rules for this project
- Always explain WHY before writing code
- Point out what would break at scale
- When writing a function, explain the decision made at each step
- Never write the next phase's code unprompted
- If I ask you to write something, ask me what my attempt would be first
- When I don't know which option to pick (library, pattern, design choice),
  present the options with tradeoffs and let me choose — don't just decide for me
- Log every non-trivial architectural choice in DECISIONS.md (decision, reasoning, tradeoff)

## File structure
payment-gateway/
├── src/
│   ├── index.js              entry point, starts server
│   ├── app.js                Express app setup, middleware
│   ├── config/db.js          PostgreSQL pool setup
│   ├── middleware/           auth.js, errorHandler.js, requestLogger.js
│   ├── routes/payments.js
│   ├── controllers/paymentController.js
│   └── services/paymentService.js   business logic, DB queries
├── db/schema.sql             CREATE TABLE statements
├── docs/STUDY_GUIDE.md       concept primer, read alongside each phase
├── .env.example
├── .env                      never commit
├── package.json
└── DECISIONS.md              every architectural decision, with why
