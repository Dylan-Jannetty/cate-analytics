/**
 * report.ts — Produce pipeline/out/weekly.json from the latest snapshot.
 *
 * Reads from Supabase (holder_balances, wallet_labels, wallet_clusters),
 * fetches live market data from DexScreener, fetches mint decimals from
 * Helius, then builds the validated WeeklyReport and writes it atomically.
 *
 * Usage:
 *   pnpm -F pipeline report             # write out/weekly.json
 *   pnpm -F pipeline report --dry-run   # compute and print summary, write nothing
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { config, createServiceClient, WeeklyReportSchema } from "@cate/shared";
import type {
  MarketData,
  RankedHolder,
  DiffEntry,
  MovementEntry,
  ConcentrationStats,
  WalletLabelKind,
} from "@cate/shared";

const isDryRun = process.argv.includes("--dry-run");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "out");
const OUT_FILE = path.join(OUT_DIR, "weekly.json");

const SOLSCAN_BASE = "https://solscan.io/account";
const WSOL = "So11111111111111111111111111111111111111112";
const MAX_RETRIES = 5;

/** Kinds that are filtered out of the ranked list entirely. */
const EXCLUDED_KINDS = new Set<string>(["lp", "burn", "exchange", "bridge", "bot"]);
/** Kinds excluded from accumulator / distributor rankings. */
const DIFF_EXCLUDED_KINDS = new Set<string>([...EXCLUDED_KINDS, "custodial"]);

// ---------------------------------------------------------------------------
// Zod schemas for external APIs
// ---------------------------------------------------------------------------

const DexPairSchema = z.object({
  dexId: z.string(),
  quoteToken: z.object({ address: z.string() }),
  priceUsd: z.string().nullable().optional(),
  priceChange: z
    .object({ h24: z.number().nullable().optional() })
    .optional(),
  volume: z
    .object({ h24: z.number().nonnegative().nullable().optional() })
    .optional(),
  liquidity: z
    .object({ usd: z.number().nonnegative().nullable().optional() })
    .optional(),
  fdv: z.number().nonnegative().nullable().optional(),
  marketCap: z.number().nonnegative().nullable().optional(),
});

const DexScreenerResponseSchema = z.object({
  pairs: z.array(DexPairSchema).nullable(),
});

const HeliusMintResponseSchema = z.object({
  result: z.object({
    value: z
      .object({
        data: z.object({
          parsed: z.object({
            info: z.object({
              decimals: z.number().int().nonnegative(),
            }),
          }),
        }),
      })
      .nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Supabase row schemas (minimal validation)
// ---------------------------------------------------------------------------

const SnapshotRowSchema = z.object({
  id: z.number(),
  taken_at: z.string(),
  total_supply: z.string(),
  holder_count: z.number(),
});
type SnapshotRow = z.infer<typeof SnapshotRowSchema>;

const HolderBalanceRowSchema = z.object({
  owner: z.string(),
  amount: z.string(),
});
type HolderBalanceRow = z.infer<typeof HolderBalanceRowSchema>;

const LabelRowSchema = z.object({
  owner: z.string(),
  kind: z.string(),
  label: z.string().nullable(),
  notes: z.string().nullable(),
});
type LabelRow = z.infer<typeof LabelRowSchema>;

const ClusterRowSchema = z.object({
  owner: z.string(),
  cluster_id: z.string(),
});
type ClusterRow = z.infer<typeof ClusterRowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempt = 1
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) throw new Error(`429 after ${MAX_RETRIES} retries: ${url}`);
    const delay = Math.pow(2, attempt) * 1000;
    console.log(`[report] Rate limited. Retrying in ${delay}ms…`);
    await sleep(delay);
    return fetchWithRetry(url, init, attempt + 1);
  }
  return res;
}

function solscanUrl(address: string): string {
  return `${SOLSCAN_BASE}/${address}`;
}

/**
 * Format a raw bigint token amount into a human-readable string.
 * Shows up to 4 significant decimal places, trailing zeros trimmed.
 */
function formatTokens(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const wholeStr = whole.toLocaleString("en-US");
  if (frac === 0n) return `${sign}${wholeStr}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return `${sign}${wholeStr}.${fracStr}`;
}

/** Format a signed delta with a leading +/- sign. */
function formatDelta(raw: bigint, decimals: number): string {
  if (raw >= 0n) return `+${formatTokens(raw, decimals)}`;
  return formatTokens(raw, decimals); // negative sign already included
}

/** Percentage of total supply, 3 decimal places. */
function pctOfSupply(amount: bigint, totalSupply: bigint): number {
  if (totalSupply === 0n) return 0;
  return Number((amount * 100_000n) / totalSupply) / 1_000;
}

/** Percentage of total supply for a slice of entities (top N). */
function topNPct(
  entities: { amount: bigint }[],
  topN: number,
  totalSupply: bigint
): number {
  const sum = entities.slice(0, topN).reduce((acc, e) => acc + e.amount, 0n);
  return pctOfSupply(sum, totalSupply);
}

function toUsd(raw: bigint, decimals: number, priceUsd: number | null): number | null {
  if (priceUsd === null) return null;
  return (Number(raw) / 10 ** decimals) * priceUsd;
}

/** USD value of a signed delta (preserves sign). */
function deltaUsd(delta: bigint, decimals: number, priceUsd: number | null): number | null {
  const abs = toUsd(delta < 0n ? -delta : delta, decimals, priceUsd);
  if (abs === null) return null;
  return delta < 0n ? -abs : abs;
}

// ---------------------------------------------------------------------------
// External data fetching
// ---------------------------------------------------------------------------

async function fetchMintDecimals(
  mint: string,
  apiKey: string
): Promise<number> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mint-info",
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed" }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Helius getAccountInfo error ${res.status}: ${await res.text()}`);
  }

  const json: unknown = await res.json();
  const parsed = HeliusMintResponseSchema.parse(json);

  if (!parsed.result.value) {
    throw new Error(`Mint account not found: ${mint}`);
  }

  return parsed.result.value.data.parsed.info.decimals;
}

async function fetchMarketData(mint: string): Promise<MarketData | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });

    if (!res.ok) {
      console.warn(`[report] DexScreener returned ${res.status}; market data will be null.`);
      return null;
    }

    const json: unknown = await res.json();
    const parsed = DexScreenerResponseSchema.parse(json);

    if (!parsed.pairs || parsed.pairs.length === 0) {
      console.warn("[report] DexScreener: no pairs found; market data will be null.");
      return null;
    }

    // Prefer a SOL (WSOL) quote pair; fall back to the most liquid pair overall.
    const solPairs = parsed.pairs.filter((p) => p.quoteToken.address === WSOL);
    const candidates = solPairs.length > 0 ? solPairs : parsed.pairs;

    // Pick the pair with the highest USD liquidity.
    const best = candidates.reduce((a, b) => {
      const la = a.liquidity?.usd ?? 0;
      const lb = b.liquidity?.usd ?? 0;
      return lb > la ? b : a;
    });

    const priceUsd = best.priceUsd ? parseFloat(best.priceUsd) : null;
    if (priceUsd === null || isNaN(priceUsd)) {
      console.warn("[report] DexScreener: priceUsd missing; market data will be null.");
      return null;
    }

    return {
      priceUsd,
      priceChange24h: best.priceChange?.h24 ?? null,
      priceChange7d: null, // DexScreener public API does not expose 7d change
      volumeUsd24h: best.volume?.h24 ?? null,
      marketCapUsd: best.marketCap ?? best.fdv ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("[report] DexScreener fetch failed:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entity building
//
// "Entity" = a distinct holder after filtering and cluster collapsing.
// Clusters labeled kind='cluster' in wallet_labels are collapsed: all members
// share a cluster_id from wallet_clusters, and their amounts are summed.
// ---------------------------------------------------------------------------

type EntityData = {
  stableId: string;         // cluster_id for clusters, owner for singletons
  representative: string;   // the owner address shown to users
  members: string[];        // all wallet addresses in this entity
  amount: bigint;
  kind: WalletLabelKind | undefined;
  note: string | undefined;
  isCluster: boolean;
};

type RankedEntity = EntityData & { rank: number };

function buildRankedEntities(
  holders: HolderBalanceRow[],
  labelByOwner: Map<string, LabelRow>,
  clusterIdByOwner: Map<string, string>
): RankedEntity[] {
  // Identify owners that have been labeled 'cluster' (3+ wallet clusters).
  // These are collapsed; their cluster siblings are included even if not
  // individually labeled.
  const clusterOwners = new Set<string>();
  for (const [owner, label] of labelByOwner) {
    if (label.kind === "cluster") clusterOwners.add(owner);
  }

  // Group cluster owners by their cluster_id.
  const groupByClusterId = new Map<string, Set<string>>();
  for (const owner of clusterOwners) {
    const cid = clusterIdByOwner.get(owner);
    if (!cid) continue;
    const g = groupByClusterId.get(cid) ?? new Set();
    g.add(owner);
    groupByClusterId.set(cid, g);
  }

  // Also include any cluster sibling that shares the same cluster_id,
  // even if it isn't individually labeled (can happen on the first run after
  // cluster.ts, before wallet_labels is fully populated).
  for (const [owner, cid] of clusterIdByOwner) {
    if (!groupByClusterId.has(cid)) continue; // only extend known groups
    const g = groupByClusterId.get(cid)!;
    g.add(owner);
  }

  const allClusterMembers = new Set<string>(
    [...groupByClusterId.values()].flatMap((s) => [...s])
  );

  // Amount lookup map (owner → bigint).
  const amountByOwner = new Map<string, bigint>();
  for (const row of holders) {
    amountByOwner.set(row.owner, BigInt(row.amount));
  }

  const entities: EntityData[] = [];

  // Standalone entities (not in any cluster group, not excluded).
  for (const row of holders) {
    const owner = row.owner;
    if (allClusterMembers.has(owner)) continue;
    const label = labelByOwner.get(owner);
    if (label && EXCLUDED_KINDS.has(label.kind)) continue;

    entities.push({
      stableId: owner,
      representative: owner,
      members: [owner],
      amount: BigInt(row.amount),
      kind: label?.kind as WalletLabelKind | undefined,
      note: label?.notes ?? undefined,
      isCluster: false,
    });
  }

  // Cluster entities (one per cluster_id).
  for (const [clusterId, memberSet] of groupByClusterId) {
    const members = [...memberSet].filter((m) => {
      const lbl = labelByOwner.get(m);
      return !lbl || !EXCLUDED_KINDS.has(lbl.kind);
    });

    if (members.length === 0) continue;

    const amount = members.reduce(
      (sum, m) => sum + (amountByOwner.get(m) ?? 0n),
      0n
    );

    // Representative = member with the highest individual balance.
    const representative = members.reduce((best, m) => {
      return (amountByOwner.get(m) ?? 0n) > (amountByOwner.get(best) ?? 0n)
        ? m
        : best;
    // members.length > 0 guaranteed by the check above
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    }, members[0]!);

    const repLabel = labelByOwner.get(representative);

    entities.push({
      stableId: clusterId,
      representative,
      members,
      amount,
      kind: "cluster",
      note: repLabel?.notes ?? `${members.length} wallets`,
      isCluster: true,
    });
  }

  // Sort by amount descending and assign ranks.
  entities.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));

  return entities.map((e, i) => ({ ...e, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Report assembly helpers
// ---------------------------------------------------------------------------

function makeRankedHolder(
  curr: RankedEntity,
  priorRankByStableId: Map<string, number>,
  priorAmountByStableId: Map<string, bigint>,
  totalSupply: bigint,
  decimals: number,
  priceUsd: number | null
): RankedHolder {
  const priorRank = priorRankByStableId.get(curr.stableId) ?? null;
  const priorAmount = priorAmountByStableId.get(curr.stableId) ?? 0n;
  const delta = curr.amount - priorAmount;
  const rankDelta = priorRank !== null ? priorRank - curr.rank : null;

  return {
    rank: curr.rank,
    owner: curr.representative,
    balance: formatTokens(curr.amount, decimals),
    balanceRaw: curr.amount.toString(),
    balanceUsd: toUsd(curr.amount, decimals, priceUsd),
    pct: pctOfSupply(curr.amount, totalSupply),
    rankDelta,
    balanceDelta: delta.toString(),
    balanceDeltaFormatted: formatDelta(delta, decimals),
    balanceDeltaUsd: deltaUsd(delta, decimals, priceUsd),
    ...(curr.kind !== undefined && { label: curr.kind }),
    ...(curr.note !== undefined && { note: curr.note }),
    isCluster: curr.isCluster,
    solscanUrl: solscanUrl(curr.representative),
  };
}

function makeDiffEntry(
  curr: RankedEntity,
  priorAmountByStableId: Map<string, bigint>,
  totalSupply: bigint,
  decimals: number,
  priceUsd: number | null
): DiffEntry {
  const priorAmount = priorAmountByStableId.get(curr.stableId) ?? 0n;
  const delta = curr.amount - priorAmount;
  return {
    rank: curr.rank,
    owner: curr.representative,
    solscanUrl: solscanUrl(curr.representative),
    balance: formatTokens(curr.amount, decimals),
    balanceRaw: curr.amount.toString(),
    balanceUsd: toUsd(curr.amount, decimals, priceUsd),
    pct: pctOfSupply(curr.amount, totalSupply),
    balanceDelta: delta.toString(),
    balanceDeltaFormatted: formatDelta(delta, decimals),
    balanceDeltaUsd: deltaUsd(delta, decimals, priceUsd),
    ...(curr.kind !== undefined && { label: curr.kind }),
    ...(curr.note !== undefined && { note: curr.note }),
    isCluster: curr.isCluster,
  };
}

function makeMovementEntry(
  representative: string,
  currentRank: number | null,
  priorRank: number | null,
  amount: bigint,
  totalSupply: bigint,
  decimals: number,
  priceUsd: number | null,
  kind: WalletLabelKind | undefined,
  note: string | undefined,
  isCluster: boolean
): MovementEntry {
  return {
    owner: representative,
    solscanUrl: solscanUrl(representative),
    currentRank,
    priorRank,
    balance: formatTokens(amount, decimals),
    balanceRaw: amount.toString(),
    balanceUsd: toUsd(amount, decimals, priceUsd),
    pct: pctOfSupply(amount, totalSupply),
    ...(kind !== undefined && { label: kind }),
    ...(note !== undefined && { note }),
    isCluster,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mint = config.tokenMint;
  const apiKey = config.heliusApiKey;
  console.log(`[report] Token mint: ${mint}`);
  console.log(`[report] Dry run:    ${isDryRun}`);

  const supabase = createServiceClient();

  // ── 1. Fetch latest two snapshots ─────────────────────────────────────────

  const { data: snapRows, error: snapErr } = await supabase
    .from("snapshots")
    .select("id, taken_at, total_supply, holder_count")
    .eq("mint", mint)
    .order("taken_at", { ascending: false })
    .limit(2);

  if (snapErr || !snapRows || snapRows.length === 0) {
    throw new Error(`No snapshots found: ${snapErr?.message ?? "empty result"}`);
  }

  const snapshots = z.array(SnapshotRowSchema).parse(snapRows);
  const current = snapshots[0];
  const prior: SnapshotRow | null = snapshots[1] ?? null;

  console.log(`[report] Current snapshot: id=${current.id}  taken_at=${current.taken_at}`);
  if (prior) {
    console.log(`[report] Prior snapshot:   id=${prior.id}  taken_at=${prior.taken_at}`);
  } else {
    console.log("[report] No prior snapshot; deltas and movement entries will be empty.");
  }

  // ── 2. Fetch holder balances ───────────────────────────────────────────────

  const { data: currHolderRows, error: currHolderErr } = await supabase
    .from("holder_balances")
    .select("owner, amount")
    .eq("snapshot_id", current.id);

  if (currHolderErr || !currHolderRows) {
    throw new Error(`Failed to fetch current holder_balances: ${currHolderErr?.message}`);
  }
  const currentHolders = z.array(HolderBalanceRowSchema).parse(currHolderRows);

  let priorHolders: HolderBalanceRow[] = [];
  if (prior) {
    const { data: priorHolderRows, error: priorHolderErr } = await supabase
      .from("holder_balances")
      .select("owner, amount")
      .eq("snapshot_id", prior.id);

    if (priorHolderErr || !priorHolderRows) {
      throw new Error(`Failed to fetch prior holder_balances: ${priorHolderErr?.message}`);
    }
    priorHolders = z.array(HolderBalanceRowSchema).parse(priorHolderRows);
  }

  console.log(
    `[report] Loaded ${currentHolders.length} current / ${priorHolders.length} prior holder rows.`
  );

  // ── 3. Fetch wallet_labels and wallet_clusters ────────────────────────────

  const [{ data: labelData }, { data: clusterData }] = await Promise.all([
    supabase.from("wallet_labels").select("owner, kind, label, notes"),
    supabase.from("wallet_clusters").select("owner, cluster_id"),
  ]);

  const labelRows = z.array(LabelRowSchema).parse(labelData ?? []);
  const clusterRows = z.array(ClusterRowSchema).parse(clusterData ?? []);

  const labelByOwner = new Map<string, LabelRow>(labelRows.map((r) => [r.owner, r]));
  const clusterIdByOwner = new Map<string, string>(clusterRows.map((r) => [r.owner, r.cluster_id]));

  console.log(`[report] ${labelRows.length} labels, ${clusterRows.length} cluster memberships.`);

  // ── 4. Fetch market data and mint decimals (parallel) ──────────────────────

  const [market, decimals] = await Promise.all([
    fetchMarketData(mint),
    fetchMintDecimals(mint, apiKey),
  ]);

  console.log(
    market
      ? `[report] Market data: $${market.priceUsd}  24h: ${market.priceChange24h ?? "n/a"}%  liquidity: $${market.liquidityUsd ?? "n/a"}`
      : "[report] Market data unavailable."
  );
  console.log(`[report] Mint decimals: ${decimals}`);

  const priceUsd = market?.priceUsd ?? null;

  // ── 5. Build entity lists ──────────────────────────────────────────────────

  const currentEntities = buildRankedEntities(currentHolders, labelByOwner, clusterIdByOwner);
  const priorEntities = prior
    ? buildRankedEntities(priorHolders, labelByOwner, clusterIdByOwner)
    : [];

  const priorRankByStableId = new Map<string, number>(
    priorEntities.map((e) => [e.stableId, e.rank])
  );
  const priorAmountByStableId = new Map<string, bigint>(
    priorEntities.map((e) => [e.stableId, e.amount])
  );

  const currentTotalSupply = BigInt(current.total_supply);
  const priorTotalSupply = prior ? BigInt(prior.total_supply) : null;

  console.log(`[report] ${currentEntities.length} filtered+clustered entities (current).`);

  // ── 6. Top-20 holders ─────────────────────────────────────────────────────

  const holders: RankedHolder[] = currentEntities.slice(0, 20).map((e) =>
    makeRankedHolder(e, priorRankByStableId, priorAmountByStableId, currentTotalSupply, decimals, priceUsd)
  );

  // ── 7. Top accumulators / distributors ────────────────────────────────────
  //    Custodial wallets excluded per CLAUDE.md.

  const diffCandidates = currentEntities.filter(
    (e) => !e.kind || !DIFF_EXCLUDED_KINDS.has(e.kind)
  );

  // Sort by balance delta descending for accumulators.
  const byDeltaDesc = [...diffCandidates].sort((a, b) => {
    const da = a.amount - (priorAmountByStableId.get(a.stableId) ?? 0n);
    const db = b.amount - (priorAmountByStableId.get(b.stableId) ?? 0n);
    return db > da ? 1 : db < da ? -1 : 0;
  });

  const topAccumulators: DiffEntry[] = byDeltaDesc
    .filter((e) => (e.amount - (priorAmountByStableId.get(e.stableId) ?? 0n)) > 0n)
    .slice(0, 20)
    .map((e) => makeDiffEntry(e, priorAmountByStableId, currentTotalSupply, decimals, priceUsd));

  const topDistributors: DiffEntry[] = [...byDeltaDesc]
    .reverse()
    .filter((e) => (e.amount - (priorAmountByStableId.get(e.stableId) ?? 0n)) < 0n)
    .slice(0, 20)
    .map((e) => makeDiffEntry(e, priorAmountByStableId, currentTotalSupply, decimals, priceUsd));

  // ── 8. New-in-top-100 and exited-top-100 ──────────────────────────────────

  const newInTop100: MovementEntry[] = [];
  const exitedTop100: MovementEntry[] = [];

  if (prior) {
    // New entrants: currently rank <= 100 AND (no prior rank OR prior rank > 100).
    for (const e of currentEntities) {
      if (e.rank > 100) break; // sorted, safe to break
      const priorRank = priorRankByStableId.get(e.stableId) ?? null;
      if (priorRank === null || priorRank > 100) {
        newInTop100.push(
          makeMovementEntry(
            e.representative, e.rank, priorRank,
            e.amount, currentTotalSupply, decimals, priceUsd,
            e.kind, e.note, e.isCluster
          )
        );
      }
    }

    // Exits: prior rank <= 100 AND (not in current OR current rank > 100).
    const currentRankByStableId = new Map<string, number>(
      currentEntities.map((e) => [e.stableId, e.rank])
    );
    for (const pe of priorEntities) {
      if (pe.rank > 100) break;
      const currRank = currentRankByStableId.get(pe.stableId) ?? null;
      if (currRank === null || currRank > 100) {
        const currAmount = currentEntities.find((e) => e.stableId === pe.stableId)?.amount ?? 0n;
        exitedTop100.push(
          makeMovementEntry(
            pe.representative, currRank, pe.rank,
            currAmount, currentTotalSupply, decimals, priceUsd,
            pe.kind, pe.note, pe.isCluster
          )
        );
      }
    }
  }

  // ── 9. Concentration stats ─────────────────────────────────────────────────

  const top10Pct = topNPct(currentEntities, 10, currentTotalSupply);
  const top50Pct = topNPct(currentEntities, 50, currentTotalSupply);
  const top100Pct = topNPct(currentEntities, 100, currentTotalSupply);

  let top10PctDelta: number | null = null;
  let top50PctDelta: number | null = null;
  let top100PctDelta: number | null = null;

  if (prior && priorTotalSupply !== null) {
    const priorTop10Pct = topNPct(priorEntities, 10, priorTotalSupply);
    const priorTop50Pct = topNPct(priorEntities, 50, priorTotalSupply);
    const priorTop100Pct = topNPct(priorEntities, 100, priorTotalSupply);
    // Round to 3 dp to avoid floating-point noise.
    top10PctDelta = Math.round((top10Pct - priorTop10Pct) * 1000) / 1000;
    top50PctDelta = Math.round((top50Pct - priorTop50Pct) * 1000) / 1000;
    top100PctDelta = Math.round((top100Pct - priorTop100Pct) * 1000) / 1000;
  }

  const concentration: ConcentrationStats = {
    top10Pct,
    top50Pct,
    top100Pct,
    top10PctDelta,
    top50PctDelta,
    top100PctDelta,
  };

  // ── 10. Assemble and validate ──────────────────────────────────────────────

  const report = {
    mint,
    generatedAt: new Date().toISOString(),
    snapshotDate: current.taken_at,
    priorSnapshotDate: prior?.taken_at ?? null,
    decimals,
    market,
    holders,
    topAccumulators,
    topDistributors,
    newInTop100,
    exitedTop100,
    concentration,
    totalSupplyRaw: current.total_supply,
    holderCountRaw: current.holder_count,
    holderCountFiltered: currentEntities.length,
  };

  // Validate against the shared Zod schema. Fails loudly on mismatch.
  WeeklyReportSchema.parse(report);
  console.log("[report] Zod validation passed.");

  // ── 11. Print summary ─────────────────────────────────────────────────────

  console.log("\n[report] === Summary ===");
  if (market) {
    console.log(`  Price:       $${market.priceUsd}  (24h: ${market.priceChange24h ?? "n/a"}%)`);
    console.log(`  Market cap:  $${market.marketCapUsd?.toLocaleString("en-US") ?? "n/a"}`);
    console.log(`  Liquidity:   $${market.liquidityUsd?.toLocaleString("en-US") ?? "n/a"}`);
    console.log(`  Volume 24h:  $${market.volumeUsd24h?.toLocaleString("en-US") ?? "n/a"}`);
  }
  console.log(`  Holders (raw/filtered): ${current.holder_count} / ${currentEntities.length}`);
  console.log(`  Top-20 holder #1:  ${holders[0]?.owner ?? "n/a"}  ${holders[0]?.balance ?? ""}`);
  console.log(`  Accumulators:      ${topAccumulators.length}`);
  console.log(`  Distributors:      ${topDistributors.length}`);
  console.log(`  New in top-100:    ${newInTop100.length}`);
  console.log(`  Exited top-100:    ${exitedTop100.length}`);
  console.log(
    `  Concentration:     top10=${top10Pct.toFixed(2)}% (${top10PctDelta !== null ? `${top10PctDelta > 0 ? "+" : ""}${top10PctDelta.toFixed(2)}pp` : "n/a"})` +
    `  top50=${top50Pct.toFixed(2)}%  top100=${top100Pct.toFixed(2)}%`
  );

  if (isDryRun) {
    console.log("\n[report] --dry-run: nothing written.");
    return;
  }

  // ── 12. Write atomically ──────────────────────────────────────────────────

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  // Write to a sibling tmp file first, then rename atomically. Both must be on
  // the same filesystem for rename(2) to be atomic — hence the tmp lives in OUT_DIR.
  const tmpFile = path.join(OUT_DIR, ".weekly.tmp.json");
  fs.writeFileSync(tmpFile, json, "utf8");
  fs.renameSync(tmpFile, OUT_FILE);

  console.log(`\n[report] Written to ${OUT_FILE}  (${(json.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("[report] Fatal:", err);
  process.exit(1);
});
