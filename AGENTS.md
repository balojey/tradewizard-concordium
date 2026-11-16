# AGENTS.md

TradeWizard: AI prediction-trading platform for Polymarket. Three independent Node packages (own `package.json` / `node_modules`, no shared code): `infra/` (AWS CDK + Lambda backend), `tradewizard-frontend/` (Next.js 16 App Router, customer product), and `tradewizard-admin/` (Next.js 16 App Router, internal management portal). Read `.kiro/steering/{product,structure,tech}.md` for the authoritative architecture before big changes - the root/infra READMEs are long but partially stale.

**Management portal:** `tradewizard-admin/` is built and deployed separately from the product; `docs/admin-portal-architecture.md` is the binding specification for all admin work - Cognito roles, the `admin-api` Lambda + route contracts, the audit model, and the required `shared/` refactors. Read it before touching anything admin-related; §14.1 is the execution order, §14.4 is the progress log (update it in the same PR as each slice), and §17 has the construction playbooks. §9.1/§9.2 define the UI primitives (`Page`/`PageHeader`/`Panel`/`StatCard`/`Dialog`) - new pages compose those rather than hand-rolling headers and overlays. Operational procedures (bootstrapping an admin, TOTP, schema recovery, troubleshooting) live in `docs/admin-portal-runbook.md`.

**Warden access:** `docs/warden-invite-links-plan.md` is the agreed design and slice log for role-carrying invite links and the mandatory `+warden` email aliasing on every Warden account (`name@gmail.com` → `name+warden@gmail.com`, so an admin never shares a Cognito identity with a customer). Read §2 (decisions) and §8 (security) before "simplifying" it; the link is a bearer token, the join endpoint is deliberately unauthenticated, and the token is hash-only in the database. Add a progress row to its §15 in the same PR as each slice.

**Newsletter:** `docs/newsletter-plan.md` is the agreed design and slice log for marketing email. Consent is explicit (one-time post-sign-in prompt + account toggle); there is no pre-checked box and no login-page checkbox, by decision. `newsletter_enabled` is the kill switch; unsubscribe is exempt from it by design.

**Customer support:** `docs/support-tickets-plan.md` is the agreed design and slice log for in-product support tickets (customer form + tokenised thread + admin Support inbox). Decisions 1–6 there are deliberate - read them before "fixing" the missing inbound email, anonymous account linking, or the portal-only queue. Add a progress row to its §10 in the same PR as each slice.

## Commands

### infra/
```bash
npm run build        # tsc typecheck (no bundling)
npm test             # vitest (shared email sender tests + future suites)
npm run synth:dev    # cdk synth -c env=development   (env context is required)
npm run diff:dev     # cdk diff -c env=development
./deploy.sh up dev   # full deploy: loads .env.dev, then CDK + CLOB/Resend/Nebius creds + DB migration + SES
./deploy.sh up dev --skip-db   # CDK-only, fastest iteration
./deploy.sh status dev
npm run seed:demo         # fill dev with Warden demo data (--dry-run to preview)
npm run cleanup:demo      # preview the removal; nothing is deleted
npm run cleanup:demo:apply  # actually delete the demo data
```
- `deploy.sh` loads gitignored `.env.dev` / `.env.prod` (fallback `.env`); env vars there feed `lib/config.ts` and CDK. `--skip-agents` is NOT supported (only `--skip-db`); docs referencing it are wrong.
- `down prod` requires typing the env name; dev asks for Enter.
- Lambda handlers are `infra/services/<service>/handler.ts`, wired in `lib/compute-stack.ts`.

### tradewizard-frontend/
```bash
npm run dev / build / start / lint
npx tsc --noEmit     # typecheck (no script exists; build does it in CI)
```
- No test runner. Amplify CI (`amplify.yml`) builds with Node 20 (`nvm use 20`).

### tradewizard-admin/
```bash
npm run dev          # port 3001
npm run build / start / lint
npm run typecheck    # tsc --noEmit
```
- Internal only; `.env.local` needs `NEXT_PUBLIC_ADMIN_API_BASE_URL` (trailing slash, stage included), `NEXT_PUBLIC_COGNITO_REGION`, `NEXT_PUBLIC_ADMIN_CLIENT_ID`.
- No test runner. The route guard is `proxy.ts` (Next 16 convention); the API authorizer is the real security boundary.

## Architecture gotchas

- **User identity**: cross-service contracts (DynamoDB, SNS, EventBridge) use the internal `users.id` UUID, never the Cognito `cognito_sub`. Translate at the boundary via `getUserIdByCognitoSub()` in `infra/services/shared/db.ts`. Handlers receive the JWT `sub` from API Gateway; always resolve before touching Aurora/DynamoDB.
- **DB schema**: one consolidated, idempotent file `infra/sql/001-schema.sql` (deploy.sh runs it via psql, safe to re-run). Do not create new `NNN-*.sql` files without coordinating deploy.sh; docs referencing split `001-initial-schema.sql` / `003-portfolio-manager.sql` are stale.
- **Analysis pipeline**: all 14 intelligence agents run on every market (no conditional selection). Prompts live in `analysis-lambda/stages/intelligence-agents.ts`; logical model assignments live in `analysis-lambda/lib/multi-model.ts` and resolve through `services/shared/ai-provider.ts` to Bedrock (default) or Nebius Token Factory (`AI_PROVIDER=nebius`). `signal-fusion` and `consensus-engine` are deterministic (no LLM) - keep them that way. `analysis-orchestrator` is a thin dispatcher invoking `analysis-lambda` via `@aws-sdk/client-lambda`.
- **AI provider switch**: `AI_PROVIDER=bedrock` (default) or `nebius`. Nebius uses the OpenAI-compatible Token Factory API via Strands `OpenAIModel` and the `tw-{env}-nebius-api-key` secret (`NEBIUS_API_KEY` in `.env` feeds deploy.sh). It only changes model inference; Polymarket order execution stays in the portfolio executor. Tool-using agents must map to tool-capable capabilities (`fast`, `analytical`, `agentic`, `reasoning`, `deep_reasoning`, `default`); `non_tool` is only for stages without tools. Validate IDs/tool calling with `infra/scripts/validate-nebius.ts`.
- **Env knobs**: `AI_PROVIDER` (`bedrock` default / `nebius`), `BEDROCK_MODEL_ID`, `NEBIUS_MODEL_*`, `CONSENSUS_MODE` (`anchored` default / `agent` opt-in), `GATE_PROFILE` (`actionable` default / `strict`), `ANALYSIS_HISTORY_DEPTH` (default 5, clamped 1–20) set in compute-stack; see `infra/.env.example`.
- **Portfolio manager** lambdas lazy-load Polymarket CLOB credentials from Secrets Manager `tw-{env}-clob-credentials` (`services/shared/clob-credentials.ts`) and refuse to place/cancel orders when empty. Set `CLOB_API_KEY/SECRET/PASSPHRASE` in `.env.dev` and re-deploy.
- **Email delivery**: all transactional email goes through `services/shared/email.ts`. Resend is primary (`EMAIL_PROVIDER=resend`, key in Secrets Manager `tw-{env}-resend-api-key`, `RESEND_API_KEY` in `.env` feeds deploy.sh); SES is retained but disabled unless `EMAIL_PROVIDER=ses`. Senders: `email-delivery` (analysis), `portfolio-notification` (portfolio events), `system-email-delivery` (subscription renewal/trial/downgrade notices), `support-api` (support acknowledgements, from `support@tradewizard.live`, deliberately no Reply-To). Do not add direct SES/Resend calls elsewhere.
- **Frontend provider order matters**: `providers/index.tsx` composes Auth → Wallet → Query → WebSocket → Trading. Auth outermost; WebSocket inside Query (it invalidates query cache). Auth tokens: localStorage `tw_*` keys; `middleware.ts` guards `/markets`, `/insights`, `/portfolio*`, `/account` via `tw_id_token` cookie.

## Stale sources

- `docs/agentcore-migration.md` describes a legacy Bedrock Agents architecture already replaced by the self-hosted Strands SDK Lambdas. `infra/README.md` and root `README.md` contain outdated file names, flags, and agent-count details - trust `.kiro/steering/` and the code over them.