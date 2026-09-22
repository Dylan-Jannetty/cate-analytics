/**
 * cluster.ts — Funder-based wallet clustering for the top 500 holders.
 *
 * For each holder in the latest snapshot, the script fetches the wallet's
 * transaction history from Helius enhanced transactions and identifies the
 * first address that sent SOL inbound (the "funder"). Wallets that share
 * a funder are grouped into a cluster (cluster_id = funder address).
 * Clusters of 3+ wallets are flagged with a wallet_labels row of kind 'cluster'.
 *
 * Limitations:
 *   - History is capped at MAX_PAGES × 100 transactions per wallet.
 *     Wallets older than this cap may have truncated funder detection.
 *   - Funders that are already labelled as exchange/lp/burn/bridge are
 *     treated as infrastructure and excluded from cluster grouping.
 *
 * Usage:
 *   pnpm -F pipeline cluster             # write results to Supabase
 *   pnpm -F pipeline cluster --dry-run   # print summary, write nothing
 */

import { config, createServiceClient } from "@cate/shared";
import { z } from "zod";

const isDryRun = process.argv.includes("--dry-run");

const TOP_N = 500;
const MAX_PAGES = 5;      // max pages per wallet: 5 × 100 = 500 txns
const PAGE_SIZE = 100;
const CONCURRENCY = 1;    // sequential — Helius free-tier enhanced tx endpoint is ~1-2 RPS
const MAX_RETRIES = 5;
const DB_BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// Zod schemas for Helius enhanced transactions endpoint
// ---------------------------------------------------------------------------

const NativeTransferSchema = z.object({
  fromUserAccount: z.string(),
  toUserAccount: z.string(),
  amount: z.number(), // lamports
});

const EnhancedTxnSchema = z.object({
  signature: z.string(),
  timestamp: z.number(),
  nativeTransfers: z.array(NativeTransferSchema).optional().default([]),
});

const EnhancedTxnArraySchema = z.array(EnhancedTxnSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, attempt = 1): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Helius 429 after ${MAX_RETRIES} attempts`);
    }
    const delay = Math.pow(2, attempt) * 1000;
    console.log(
      `[cluster] Rate limited. Retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`
    );
    await sleep(delay);
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Find the first inbound SOL funder for a wallet
//
// Helius enhanced transactions are returned newest-first. We paginate
// backward until we reach the beginning of history or hit MAX_PAGES.
// The oldest inbound native SOL transfer found is treated as the funding
// event that created the wallet.
// ---------------------------------------------------------------------------

type FunderResult = {
  funder: string;
  truncated: boolean; // true if we hit MAX_PAGES before reaching history start
};

async function findFunder(
  address: string,
  apiKey: string
): Promise<FunderResult | null> {
  let before: string | undefined;
  let reachedEnd = false;
  const inboundTransfers: Array<{
    fromUserAccount: string;
    timestamp: number;
  }> = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "api-key": apiKey,
      limit: String(PAGE_SIZE),
    });
    if (before) params.set("before", before);

    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?${params}`;
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[cluster] Helius ${res.status} for ${address}: ${body.slice(0, 120)}`
      );
      return null;
    }

    const raw: unknown = await res.json();
    const txns = EnhancedTxnArraySchema.parse(raw);

    if (txns.length === 0) {
      reachedEnd = true;
      break;
    }

    for (const txn of txns) {
      for (const transfer of txn.nativeTransfers) {
        if (transfer.toUserAccount === address && transfer.amount > 0) {
          inboundTransfers.push({
            fromUserAccount: transfer.fromUserAccount,
            timestamp: txn.timestamp,
          });
        }
      }
    }

    if (txns.length < PAGE_SIZE) {
      reachedEnd = true;
      break;
    }

    // Cursor for the next (older) page
    before = txns[txns.length - 1].signature;
  }

  if (inboundTransfers.length === 0) return null;

  // The oldest inbound transfer is the original funder
  inboundTransfers.sort((a, b) => a.timestamp - b.timestamp);
  return {
    funder: inboundTransfers[0].fromUserAccount,
    truncated: !reachedEnd,
  };
}

// ---------------------------------------------------------------------------
// Concurrent batch processor
// ---------------------------------------------------------------------------

async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  interBatchDelayMs = 0,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const sliceResults = await Promise.all(
      slice.map((item, j) => fn(item, i + j))
    );
    for (let j = 0; j < sliceResults.length; j++) {
      results[i + j] = sliceResults[j];
    }
    if (interBatchDelayMs > 0 && i + concurrency < items.length) {
      await sleep(interBatchDelayMs);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mint = config.tokenMint;
  const apiKey = config.heliusApiKey;
  console.log(`[cluster] Token mint: ${mint}`);
  console.log(`[cluster] Dry run:    ${isDryRun}`);
  console.log(`[cluster] Top-N:      ${TOP_N}  |  Max pages/wallet: ${MAX_PAGES}  |  Concurrency: ${CONCURRENCY}`);

  const supabase = createServiceClient();

  // 1. Latest snapshot for this mint
  const { data: latestSnap, error: snapErr } = await supabase
    .from("snapshots")
    .select("id, taken_at")
    .eq("mint", mint)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snapErr || !latestSnap) {
    throw new Error(
      `No snapshot found for mint ${mint}: ${snapErr?.message ?? "no rows"}`
    );
  }
  console.log(
    `[cluster] Using snapshot id=${latestSnap.id as number}  taken_at=${latestSnap.taken_at as string}`
  );

  // 2. Top-500 holders from that snapshot
  const { data: holderRows, error: holderErr } = await supabase
    .from("holder_balances")
    .select("owner")
    .eq("snapshot_id", latestSnap.id)
    .order("rank", { ascending: true })
    .limit(TOP_N);

  if (holderErr || !holderRows) {
    throw new Error(
      `Failed to fetch holder_balances: ${holderErr?.message ?? "no data"}`
    );
  }
  const owners = holderRows.map((r) => r.owner as string);
  console.log(`[cluster] ${owners.length} holder(s) loaded from snapshot.`);

  // 3. Fetch existing labels to skip already-classified wallets and to
  //    detect infrastructure funders (exchange/lp/burn/bridge).
  const { data: labelRows } = await supabase
    .from("wallet_labels")
    .select("owner, kind");

  const infraKinds = new Set(["exchange", "lp", "burn", "bridge"]);
  const labeledOwners = new Set<string>(
    labelRows?.map((r) => r.owner as string) ?? []
  );
  const infraAddresses = new Set<string>(
    labelRows
      ?.filter((r) => infraKinds.has(r.kind as string))
      .map((r) => r.owner as string) ?? []
  );

  const toProcess = owners.filter((o) => !labeledOwners.has(o));
  console.log(
    `[cluster] ${labeledOwners.size} already-labelled wallet(s) skipped. ` +
    `Processing ${toProcess.length} wallet(s).`
  );

  // 4. Find funders via Helius enhanced transactions
  console.log("[cluster] Starting funder lookup (this may take a few minutes)...");
  let truncatedCount = 0;
  let noFunderCount = 0;

  const funderMap = new Map<string, string>(); // owner → funder

  await runConcurrent(toProcess, CONCURRENCY, async (owner, index) => {
    const result = await findFunder(owner, apiKey);
    if (!result) {
      noFunderCount++;
    } else {
      funderMap.set(owner, result.funder);
      if (result.truncated) truncatedCount++;
    }
    if ((index + 1) % 50 === 0 || index + 1 === toProcess.length) {
      console.log(
        `[cluster]   ${index + 1}/${toProcess.length} processed  ` +
        `(funders found: ${funderMap.size}, truncated: ${truncatedCount}, no SOL inbound: ${noFunderCount})`
      );
    }
  }, 500);

  // 5. Group wallets by funder, excluding infrastructure funders
  //    cluster_id is the funder address (per schema convention)
  const clustersByFunder = new Map<string, string[]>(); // funder → [owner, ...]
  for (const [owner, funder] of funderMap) {
    if (infraAddresses.has(funder)) continue;
    const members = clustersByFunder.get(funder) ?? [];
    members.push(owner);
    clustersByFunder.set(funder, members);
  }

  // 6. Build wallet_clusters rows (all wallets with a non-infra funder)
  const clusterRows: Array<{ owner: string; funder: string; cluster_id: string }> = [];
  for (const [funder, members] of clustersByFunder) {
    for (const owner of members) {
      clusterRows.push({ owner, funder, cluster_id: funder });
    }
  }

  // 7. Clusters of 3+ wallets → flagged for wallet_labels
  const flaggedClusters = [...clustersByFunder.entries()]
    .filter(([, members]) => members.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);

  // 8. Summary output
  // Entity collapse: each cluster of N counts as 1 entity, not N
  const collapseCount = [...clustersByFunder.values()].reduce(
    (sum, members) => (members.length >= 2 ? sum + members.length - 1 : sum),
    0
  );
  const entityCount = owners.length - collapseCount;

  console.log("\n[cluster] === Summary ===");
  console.log(`  Top-${TOP_N} holders:                   ${owners.length} wallets`);
  console.log(`  Already labelled (skipped):         ${labeledOwners.size}`);
  console.log(`  Processed:                          ${toProcess.length}`);
  console.log(`  Funders resolved:                   ${funderMap.size}`);
  console.log(`    └─ infra funder (skipped):        ${funderMap.size - clusterRows.length}`);
  console.log(`  Wallets with a non-infra funder:    ${clusterRows.length}`);
  console.log(`  Distinct funders (clusters):        ${clustersByFunder.size}`);
  console.log(`  Clusters of 3+ (flagged):           ${flaggedClusters.length}`);
  console.log(`  Truncated wallet histories:         ${truncatedCount}`);
  console.log(`  No inbound SOL found:               ${noFunderCount}`);
  console.log(`\n  ${owners.length} top-500 wallets → ~${entityCount} distinct entities after cluster collapse`);

  if (flaggedClusters.length > 0) {
    console.log("\n  Flagged clusters (size ≥ 3):");
    for (const [funder, members] of flaggedClusters) {
      console.log(`\n    Funder: https://solscan.io/account/${funder}  (${members.length} wallets)`);
      for (const member of members) {
        console.log(`      https://solscan.io/account/${member}`);
      }
    }
  }

  if (isDryRun) {
    console.log("\n[cluster] --dry-run: nothing written.");
    return;
  }

  // 9. Upsert wallet_clusters
  if (clusterRows.length > 0) {
    for (let i = 0; i < clusterRows.length; i += DB_BATCH_SIZE) {
      const batch = clusterRows.slice(i, i + DB_BATCH_SIZE);
      const { error } = await supabase
        .from("wallet_clusters")
        .upsert(batch, { onConflict: "owner" });
      if (error) {
        throw new Error(`Failed to upsert wallet_clusters: ${error.message}`);
      }
    }
    console.log(`\n[cluster] ${clusterRows.length} row(s) upserted into wallet_clusters.`);
  } else {
    console.log("\n[cluster] No wallet_clusters rows to write.");
  }

  // 10. Upsert wallet_labels for flagged clusters (kind = 'cluster')
  //     Only wallets not already in wallet_labels are written to avoid
  //     overwriting a more specific label (e.g. exchange).
  const clusterLabelRows = flaggedClusters.flatMap(([funder, members]) =>
    members
      .filter((owner) => !labeledOwners.has(owner))
      .map((owner) => ({
        owner,
        label: `Cluster (funder ${funder.slice(0, 8)}…)`,
        kind: "cluster" as const,
        source: "cluster",
        notes: `${members.length} wallets share funder ${funder}`,
      }))
  );

  if (clusterLabelRows.length > 0) {
    const { error } = await supabase
      .from("wallet_labels")
      .upsert(clusterLabelRows, { onConflict: "owner" });
    if (error) {
      throw new Error(
        `Failed to upsert wallet_labels (clusters): ${error.message}`
      );
    }
    console.log(
      `[cluster] ${clusterLabelRows.length} cluster label(s) upserted into wallet_labels.`
    );
  }

  console.log("[cluster] Done.");
}

main().catch((err) => {
  console.error("[cluster] Fatal:", err);
  process.exit(1);
});
