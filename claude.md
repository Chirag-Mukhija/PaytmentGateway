# Payment Gateway — CLAUDE.md

## Project context
Learning project. Student building payment gateway to understand
backend engineering deeply. Goal is comprehension, not just working code.

## Stack
Node.js 22, Express 5, PostgreSQL 16 (pg library, no ORM), Redis 7 (ioredis),
BullMQ, Docker Compose, Nginx

## Current phase
All six phases complete (2026-09-26). Phases 3-6 were built in one
autonomous pass at the owner's request; the owner is now reviewing the code,
DECISIONS.md and the phaseN_theory_reference.docx study notes. See
PROGRESS.md for status and how each phase was verified.

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
See PROGRESS.md section 3 for the full, current layout. Top level:
src/ (API + worker), fake-bank/, merchant-mock/, db/ (schema, seed,
migrations), scripts/ (smoke, load, rate-limit, reconcile), nginx/,
docker-compose*.yml, DECISIONS.md, PROGRESS.md, phaseN_theory_reference.docx
