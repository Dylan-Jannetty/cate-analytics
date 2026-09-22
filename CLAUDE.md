# CLAUDE.md

Solana memecoin analytics: a weekly pipeline that snapshots token holders, filters bots, diffs against last week, and feeds both a static Astro site and a Resend newsletter from one `weekly.json`.

## What this is (read first)

- The **product** is the filtered ranking. Raw holder lists exist on GMGN and DexScreener for free; our value is that LPs, burns, exchanges, wallet farms, and volume bots are removed. When in doubt, favor cleaner output over more output.
- The **cost model** is free-tier everything. Any change that adds a per-request or always-on cost needs to be called out explicitly before implementing. Do not add webhooks, polling loops, or real-time subscriptions unless asked.
- **Token-agnostic.** The mint comes from `TOKEN_MINT` in env. Never hardcode the mint, pool addresses, or token name in logic. Config and labels only.

## Stack

| Layer | Tool | Notes |
| --- | --- | --- |
| Runtime | Node 20+, TypeScript, pnpm workspaces, `tsx` for scripts | strict mode on |
| Chain data | Helius DAS (`getTokenAccounts`, enhanced transactions) | free tier; Shyft is the drop-in fallback |
| Market data | DexScreener public API | no key; rate-limit politely |
| Trades (optional) | Solana Tracker free tier | skip if quota is tight |
| DB | Supabase Postgres | service key in scripts only, anon key in site |
| Cron | GitHub Actions, Sundays 18:00 UTC | commits `pipeline/out/weekly.json` |
| Site | Astro, static, Netlify | reads `weekly.json` at build |
| Email | Resend + React Email | broadcast to confirmed subscribers |
| Validation | Zod schema in `/shared` | site and email both validate `weekly.json` |

## Repo layout

```
/pipeline   scripts: snapshot.ts, label.ts, cluster.ts, report.ts, send.ts
/site       Astro site
/shared     types, Zod schemas, Supabase client
/supabase   migrations
/.github    workflows
```

## Commands

```
pnpm install
pnpm -F pipeline snapshot --dry-run     # print top 20, write nothing
pnpm -F pipeline snapshot               # write a snapshot (refuses within 6h unless --force)
pnpm -F pipeline cluster                # funder clustering on top 500
pnpm -F pipeline report                 # produce out/weekly.json
pnpm -F pipeline send --preview         # email only to OWNER_EMAIL
pnpm -F site dev
```

Env vars: `HELIUS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, `TOKEN_MINT`, `OWNER_EMAIL`. See `.env.example`.

## Solana specifics that bite

- The target token is **Token-2022**, not classic SPL. Holder queries must target the Token-2022 program. If a top-20 result doesn't roughly match GMGN, this is the first thing to check.
- One owner can hold many token accounts. Always aggregate by **owner**, never by token account.
- Amounts are `bigint` raw units. Convert with the mint's decimals once, at the edge. Store raw in Postgres `numeric`; never `float`.
- Addresses are case-sensitive base58. Never lowercase them.
- **Do not invent addresses.** Exchange wallets, pool accounts, and burn addresses come from config or from a live lookup (DexScreener pairs API, Solscan labels). If a needed address isn't available, stop and ask; do not fill in a plausible-looking one.

## Data rules

- A snapshot is immutable once written. Corrections go in `wallet_labels`, never by editing `holder_balances`.
- `wallet_labels.kind` is an enum: `lp | burn | exchange | bridge | bot | cluster | custodial | manual`. Every label row records its `source`.
- The diff view excludes `lp, burn, exchange, bridge, bot`. Clusters are collapsed to one entity, not excluded. `custodial` wallets (e.g. pooled app wallets) are shown but flagged, never ranked as accumulators.
- Wallets that buy and fully exit within the week are invisible to the diff by design. Do not add trade-level ingestion to "fix" this without discussion.
- `weekly.json` must validate against the Zod schema before it is committed. A failed run leaves the previous file in place.

## Cost guardrails

- Log Helius credit usage on every run. If a single weekly run exceeds ~5% of the free monthly allowance, flag it.
- No `getProgramAccounts` against the token program on public RPC; use DAS.
- Batch Supabase inserts in 1,000-row chunks.
- Retry 429s with exponential backoff, max 5 attempts, then fail loudly.

## Code conventions

- TypeScript strict. No `any` at module boundaries; Zod-parse all external JSON (Helius, DexScreener, Supabase rows).
- Scripts are idempotent and safe to re-run. Every script supports `--dry-run`.
- Small, single-purpose files. A script does one job and writes one artifact.
- Solscan links for every address surfaced to users: `https://solscan.io/account/<address>`.
- Site: no client-side JS framework. One small chart library max. Mobile-first, dark theme.
- Email: React Email components only; inline styles; test with `--preview` before any real send.

## Working style

- Prefer minimal changes. Don't refactor adjacent code unless asked.
- If a task needs data that isn't in the repo or env (an address list, an API key, a design decision), ask instead of guessing.
- After writing a pipeline script, run it with `--dry-run` and show the output before declaring it done.
- When adding a dependency, say why and confirm it has no runtime cost.
- Don't add "story of the week" or editorial text automatically; that section is written by hand each week.