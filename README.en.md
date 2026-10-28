# AI Software Engineer Bot — Zero-Cost Edition

A Telegram bot that understands plain-Persian feature requests, analyzes a GitHub
repository, produces a **Persian execution plan**, and — **only after an explicit,
signed approval from the owner** — creates a branch, writes real code, runs tests in
GitHub Actions and opens a Pull Request.

Deployment mode chosen by the owner: **Mode A — Serverless**
(Cloudflare Workers + D1 + Telegram webhook; code execution and tests run in GitHub
Actions). No paid service is a hard dependency.

## Status

| Area | State | Evidence |
|---|---|---|
| Bot skeleton, Persian menu, 19 commands | ✅ | 86 automated tests (mocked Telegram) |
| Owner auth + rate limiting | ✅ | tests: stranger, forged callback, burst |
| SQLite-compatible schema (15 tables) on D1/SQLite | ✅ | persistence test across restart |
| Multi-provider AI manager (Gemini/Groq/OpenRouter/DeepSeek/OpenAI/Anthropic) | ✅ | tests with HTTP mock |
| Daily/monthly free-tier caps + queueing | ✅ | tests |
| GitHub auth (real RS256 App JWT + PAT fallback) | ✅ | tests |
| Analysis engine + Persian plan report | ✅ | tests |
| Approval workflow (HMAC signed, expiring) | ✅ | tests: forged, expired, replayed |
| Branch, commit, pull request | ✅ | end-to-end test against mocked GitHub |
| Test execution via GitHub Actions + minute metering | ✅ | workflow + dispatcher tests |
| Security: redaction, prompt-injection guard, audit log | ✅ | tests |
| **Live calls to api.telegram.org / Gemini / Groq** | ⏳ | blocked in the build sandbox; run `/test_api` after deploying with your keys |

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in secrets (never commit)
npx wrangler d1 create ai-eng-bot-db  # paste the id into wrangler.toml
npm run db:migrate
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put APPROVAL_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Docs: [`docs/setup-telegram.md`](docs/setup-telegram.md) ·
[`docs/setup-github-app.md`](docs/setup-github-app.md) ·
[`docs/setup-ai-free-tiers.md`](docs/setup-ai-free-tiers.md) ·
[`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) ·
[`docs/architecture.md`](docs/architecture.md) ·
[`docs/security.md`](docs/security.md)

## Hard rules

1. No repository change without a valid approval bound to `request_id` + `plan_version`, signed and expiring. "ok", "thanks" and "hello" are **not** approvals.
2. No automatic upgrade to a paid model. Order: Gemini → Groq → OpenRouter (`:free`) → DeepSeek. OpenAI/Anthropic only if you enable them.
3. Keys never appear in code, GitHub, logs or Telegram messages.
4. Model-produced commands never run directly — only the allow-list in `src/github/commands.ts` (mirrored in the workflow).
5. Merge/publish/destructive operations require separate approval.
6. When a free quota is exhausted the bot sleeps and queues; it never spends money.

## Tests

```bash
npm test          # 86 tests: unit, integration, end-to-end (mocked HTTP)
npm run typecheck
```
