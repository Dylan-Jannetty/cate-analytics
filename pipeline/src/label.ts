/**
 * label.ts — Seed wallet_labels with LP pool accounts, the burn address,
 * and known exchange hot wallets.
 *
 * LP accounts are fetched live from DexScreener's public pairs API so the
 * list stays current as new pools are created. Exchange wallets are hardcoded
 * below — paste addresses into EXCHANGE_WALLETS before running.
 *
 * Usage:
 *   pnpm -F pipeline label             # upsert labels into Supabase
 *   pnpm -F pipeline label --dry-run   # print what would be upserted, write nothing
 */

import { config, createServiceClient } from "@cate/shared";
import { z } from "zod";

const isDryRun = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Static seed data
// ---------------------------------------------------------------------------

/**
 * Solana incinerator — the canonical burn destination on mainnet.
 * https://solscan.io/account/1nc1nerator11111111111111111111111111111111
 */
const BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";

/**
 * Known exchange / custodial hot wallets to exclude from the diff ranking.
 * Paste addresses here. Do NOT invent addresses — only add wallets you can
 * verify on-chain (Solscan labels, exchange announcements, etc.).
 *
 * Format: { address: "<base58>", label: "<Exchange Name>" }
 */
const EXCHANGE_WALLETS: Array<{ address: string; label: string }> = [
  // Paste exchange hot wallet addresses here, e.g.:
  // { address: "5tzFkiKscXHK5ZXCGbQN7uCQUSLKePMMRYBRNuMy7cUWHt3tVAM", label: "Binance Hot Wallet" },
];

// ---------------------------------------------------------------------------
// Zod schemas for DexScreener public API
// Docs: https://docs.dexscreener.com/api/reference
// ---------------------------------------------------------------------------

const DexScreenerPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string() }),
  quoteToken: z.object({ address: z.string() }),
});

const DexScreenerResponseSchema = z.object({
  // pairs is null when the mint has no listed pairs
  pairs: z.array(DexScreenerPairSchema).nullable(),
});

// ---------------------------------------------------------------------------
// LP lookup
// ---------------------------------------------------------------------------

/**
 * Fetch all Solana trading pairs for the mint from DexScreener.
 *
 * The returned `pairAddress` is the AMM pool address (Raydium pool ID,
 * Orca whirlpool address, etc.). For most AMMs the token vault account
 * is owned by a PDA derived from this pool ID — so labelling the pool
 * address covers the common case. If vault owner PDAs appear in the top
 * holders they should be added to EXCHANGE_WALLETS manually.
 */
async function fetchLpAccounts(
  mint: string
): Promise<Array<{ address: string; note: string }>> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    throw new Error(`DexScreener error ${res.status}: ${await res.text()}`);
  }

  const json: unknown = await res.json();
  const parsed = DexScreenerResponseSchema.parse(json);

  if (!parsed.pairs || parsed.pairs.length === 0) {
    console.log("[label] DexScreener returned no pairs for this mint.");
    return [];
  }

  const solanaPairs = parsed.pairs.filter((p) => p.chainId === "solana");
  console.log(
    `[label] DexScreener: ${parsed.pairs.length} total pair(s), ${solanaPairs.length} on Solana.`
  );

  return solanaPairs.map((p) => ({
    address: p.pairAddress,
    note: `${p.dexId} LP pool`,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type LabelRow = {
  owner: string;
  label: string;
  kind: "lp" | "burn" | "exchange";
  source: string;
  notes: string | null;
};

async function main() {
  const mint = config.tokenMint;
  console.log(`[label] Token mint: ${mint}`);
  console.log(`[label] Dry run:    ${isDryRun}`);

  const lpAccounts = await fetchLpAccounts(mint);

  const rows: LabelRow[] = [
    // LP pool accounts from DexScreener
    ...lpAccounts.map((lp) => ({
      owner: lp.address,
      label: lp.note,
      kind: "lp" as const,
      source: "dexscreener",
      notes: null,
    })),
    // Burn address
    {
      owner: BURN_ADDRESS,
      label: "Solana Incinerator",
      kind: "burn" as const,
      source: "manual",
      notes: null,
    },
    // Exchange hot wallets
    ...EXCHANGE_WALLETS.map((ew) => ({
      owner: ew.address,
      label: ew.label,
      kind: "exchange" as const,
      source: "manual",
      notes: null,
    })),
  ];

  console.log(`\n[label] Rows to upsert (${rows.length} total):`);
  for (const row of rows) {
    console.log(
      `  ${row.kind.padEnd(10)}  ${row.owner}  (${row.label})`
    );
    console.log(`             https://solscan.io/account/${row.owner}`);
  }

  if (isDryRun) {
    console.log("\n[label] --dry-run: nothing written.");
    return;
  }

  if (rows.length === 0) {
    console.log("[label] Nothing to upsert.");
    return;
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("wallet_labels")
    .upsert(rows, { onConflict: "owner" });

  if (error) {
    throw new Error(`Failed to upsert wallet_labels: ${error.message}`);
  }

  console.log(`\n[label] Done. ${rows.length} label(s) upserted.`);
}

main().catch((err) => {
  console.error("[label] Fatal:", err);
  process.exit(1);
});
