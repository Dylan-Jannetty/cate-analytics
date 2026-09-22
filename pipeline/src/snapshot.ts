/**
 * snapshot.ts — Fetch and store a holder snapshot for the tracked token.
 *
 * Usage:
 *   pnpm -F pipeline snapshot             # write snapshot to Supabase
 *   pnpm -F pipeline snapshot --dry-run   # print top 20, write nothing
 *   pnpm -F pipeline snapshot --force     # bypass the 6-hour dedup guard
 */

import { config, createServiceClient } from "@cate/shared";
import { z } from "zod";


const PAGE_SIZE = 1000;
const BATCH_SIZE = 1000;
const MAX_RETRIES = 5;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const isDryRun = process.argv.includes("--dry-run");
const isForce = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Zod schemas for Helius DAS getTokenAccounts response
// ---------------------------------------------------------------------------

const HeliusTokenAccountSchema = z.object({
  address: z.string(),
  mint: z.string(),
  owner: z.string(),
  amount: z.number(),
  delegated_amount: z.number().optional(),
  frozen: z.boolean().optional(),
});

const HeliusPageSchema = z.object({
  result: z.object({
    token_accounts: z.array(HeliusTokenAccountSchema),
    cursor: z.string().nullable().optional(),
  }),
});

type RawAccount = { owner: string; tokenAccount: string; amount: bigint };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  body: object,
  attempt = 1
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Helius returned 429 after ${MAX_RETRIES} attempts`);
    }
    const delayMs = Math.pow(2, attempt) * 1000;
    console.log(
      `[snapshot] Rate limited (429). Retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})`
    );
    await sleep(delayMs);
    return fetchWithRetry(url, body, attempt + 1);
  }

  return res;
}

function logCreditHeaders(headers: Headers): void {
  const candidates = [
    "rpc-request-count",
    "x-rpc-request-credits-remaining",
    "x-credits-used",
    "x-rpc-credits",
  ];
  for (const name of candidates) {
    const val = headers.get(name);
    if (val !== null) {
      console.log(`[snapshot] Helius header ${name}: ${val}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch all token accounts via Helius DAS (paginated)
// ---------------------------------------------------------------------------

async function fetchAllAccounts(mint: string): Promise<RawAccount[]> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  const accounts: RawAccount[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    page++;
    const body = {
      jsonrpc: "2.0",
      id: `snapshot-p${page}`,
      method: "getTokenAccounts",
      params: {
        mint,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        options: { showZeroBalance: false },
      },
    };

    const res = await fetchWithRetry(url, body);
    logCreditHeaders(res.headers);

    if (!res.ok) {
      throw new Error(`Helius error ${res.status}: ${await res.text()}`);
    }

    const json: unknown = await res.json();
    // Surface any JSON-RPC error before Zod attempts to parse
    if (
      json !== null &&
      typeof json === "object" &&
      "error" in json &&
      json.error !== undefined
    ) {
      throw new Error(`Helius JSON-RPC error: ${JSON.stringify(json.error)}`);
    }
    const parsed = HeliusPageSchema.parse(json);
    const tokenAccounts = parsed.result.token_accounts;

    for (const acct of tokenAccounts) {
      accounts.push({
        owner: acct.owner,
        tokenAccount: acct.address,
        // amount is a JSON number; convert to bigint via string to avoid float drift
        amount: BigInt(Math.round(acct.amount)),
      });
    }

    cursor = parsed.result.cursor ?? undefined;
    console.log(
      `[snapshot] Page ${page}: ${tokenAccounts.length} accounts fetched (running total: ${accounts.length})`
    );
  } while (cursor !== undefined);

  return accounts;
}

// ---------------------------------------------------------------------------
// Aggregate by owner, sort descending, assign rank
// ---------------------------------------------------------------------------

type RankedAccount = {
  owner: string;
  tokenAccount: string;
  amount: bigint;
  rank: number;
};

function aggregateAndRank(raw: RawAccount[]): RankedAccount[] {
  const map = new Map<string, { amount: bigint; tokenAccount: string }>();

  for (const { owner, tokenAccount, amount } of raw) {
    const existing = map.get(owner);
    if (existing) {
      existing.amount += amount;
    } else {
      map.set(owner, { amount, tokenAccount });
    }
  }

  return [...map.entries()]
    .sort(([, a], [, b]) =>
      b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0
    )
    .map(([owner, { amount, tokenAccount }], i) => ({
      owner,
      tokenAccount,
      amount,
      rank: i + 1,
    }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mint = config.tokenMint;
  console.log(`[snapshot] Token mint: ${mint}`);
  console.log(`[snapshot] Dry run: ${isDryRun}  Force: ${isForce}`);

  // Idempotency check — skip for dry-run (no DB needed)
  if (!isDryRun) {
    const supabase = createServiceClient();
    const { data: latest } = await supabase
      .from("snapshots")
      .select("taken_at")
      .eq("mint", mint)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest) {
      const ageMs = Date.now() - new Date(latest.taken_at as string).getTime();
      if (ageMs < SIX_HOURS_MS && !isForce) {
        const hoursAgo = (ageMs / 3_600_000).toFixed(1);
        console.log(
          `[snapshot] Last snapshot was ${hoursAgo}h ago — skipping. Use --force to override.`
        );
        process.exit(0);
      }
    }
  }

  // Fetch
  const raw = await fetchAllAccounts(mint);
  const ranked = aggregateAndRank(raw);
  const totalSupply = ranked.reduce((sum, h) => sum + h.amount, BigInt(0));

  console.log(
    `[snapshot] ${raw.length} token accounts → ${ranked.length} unique owners. Total supply: ${totalSupply.toString()}`
  );

  // Dry-run: print top 20 and exit
  if (isDryRun) {
    console.log("\n[snapshot] Top 20 holders:");
    for (const h of ranked.slice(0, 20)) {
      console.log(`  #${h.rank.toString().padStart(2)}  ${h.owner}  ${h.amount.toString()}`);
    }
    console.log("\n[snapshot] --dry-run: nothing written.");
    return;
  }

  // Write snapshot row
  const supabase = createServiceClient();
  const takenAt = new Date().toISOString();

  const { data: snapshot, error: snapErr } = await supabase
    .from("snapshots")
    .insert({
      taken_at: takenAt,
      mint,
      holder_count: ranked.length,
      total_supply: totalSupply.toString(),
    })
    .select("id")
    .single();

  if (snapErr || !snapshot) {
    throw new Error(`Failed to insert snapshot row: ${snapErr?.message ?? "no data returned"}`);
  }

  const snapshotId = snapshot.id as number;
  console.log(`[snapshot] Snapshot row inserted (id=${snapshotId})`);

  // Batch-insert holder_balances
  const totalBatches = Math.ceil(ranked.length / BATCH_SIZE);
  for (let i = 0; i < ranked.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const rows = ranked.slice(i, i + BATCH_SIZE).map((h) => ({
      snapshot_id: snapshotId,
      owner: h.owner,
      token_account: h.tokenAccount,
      amount: h.amount.toString(),
      rank: h.rank,
    }));

    const { error } = await supabase.from("holder_balances").insert(rows);
    if (error) {
      throw new Error(
        `Failed to insert holder_balances batch ${batchNum}/${totalBatches}: ${error.message}`
      );
    }
    console.log(`[snapshot] Batch ${batchNum}/${totalBatches} inserted (${rows.length} rows)`);
  }

  console.log(
    `[snapshot] Done. ${ranked.length} owners written to snapshot id=${snapshotId}.`
  );
}

main().catch((err) => {
  console.error("[snapshot] Fatal:", err);
  process.exit(1);
});
