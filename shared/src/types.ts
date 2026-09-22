/** Raw on-chain holder record from a snapshot. */
export interface HolderBalance {
  /** Base58 owner address. Case-sensitive; never lowercase. */
  owner: string;
  /** Raw token amount in mint's smallest unit (bigint-safe via string in JSON). */
  amount: string;
  /** Snapshot timestamp (ISO 8601). */
  snapshotAt: string;
}

/** Wallet classification label. */
export interface WalletLabel {
  owner: string;
  kind: WalletLabelKind;
  /** Human-readable note, e.g. "Raydium LP v4". */
  note?: string;
  /** Where the label came from: "dexscreener" | "manual" | "cluster" | etc. */
  source: string;
  createdAt: string;
}

export type WalletLabelKind =
  | "lp"
  | "burn"
  | "exchange"
  | "bridge"
  | "bot"
  | "cluster"
  | "custodial"
  | "manual";

/** Market data fetched from DexScreener for the report. */
export interface MarketData {
  priceUsd: number;
  /** Percent change over last 24 hours. */
  priceChange24h: number | null;
  /**
   * Percent change over last 7 days.
   * Not available from DexScreener's public API; computed from successive
   * weekly.json files once enough history exists, otherwise null.
   */
  priceChange7d: number | null;
  volumeUsd24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  /** ISO 8601 timestamp of when this data was fetched. */
  fetchedAt: string;
}

/** A single ranked holder entry in the weekly report (top-20 list). */
export interface RankedHolder {
  rank: number;
  owner: string;
  /** Formatted balance (human-readable, decimals applied, e.g. "1,234,567.89"). */
  balance: string;
  /** Raw balance as string to avoid float precision loss. */
  balanceRaw: string;
  /** USD value of the holding; null when price is unavailable. */
  balanceUsd: number | null;
  /** Percentage of total supply (0–100, 3 dp). */
  pct: number;
  /** Rank change vs prior week (positive = moved up, negative = moved down, null = new). */
  rankDelta: number | null;
  /**
   * Raw signed balance change vs prior week as a bigint string
   * (e.g. "+5000000000"). Equals current balance for new entrants (priorAmount = 0).
   */
  balanceDelta: string;
  /** Human-readable signed delta, e.g. "+1,234,567" or "-890,000". */
  balanceDeltaFormatted: string;
  /** USD value of the balance change; null when price is unavailable. */
  balanceDeltaUsd: number | null;
  label?: WalletLabelKind;
  note?: string;
  /** True when this entry represents a collapsed cluster of wallets. */
  isCluster: boolean;
  solscanUrl: string;
}

/** An entry in the top accumulators or top distributors list. */
export interface DiffEntry {
  rank: number;
  owner: string;
  solscanUrl: string;
  /** Formatted current balance. */
  balance: string;
  balanceRaw: string;
  balanceUsd: number | null;
  /** Percentage of total supply (0–100). */
  pct: number;
  /** Raw signed balance delta as a bigint string. */
  balanceDelta: string;
  /** Human-readable signed delta, e.g. "+5,000,000". */
  balanceDeltaFormatted: string;
  balanceDeltaUsd: number | null;
  label?: WalletLabelKind;
  note?: string;
  isCluster: boolean;
}

/** A wallet that entered or exited the top-100 this week. */
export interface MovementEntry {
  owner: string;
  solscanUrl: string;
  /** Current rank, or null if the wallet fully exited (sold all tokens). */
  currentRank: number | null;
  /** Prior rank, or null if this wallet was never in the top-100 before. */
  priorRank: number | null;
  /** Formatted current balance ("0" if fully exited). */
  balance: string;
  balanceRaw: string;
  balanceUsd: number | null;
  pct: number;
  label?: WalletLabelKind;
  note?: string;
  isCluster: boolean;
}

/** Holder concentration stats — share of total supply held by top N entities. */
export interface ConcentrationStats {
  top10Pct: number;
  top50Pct: number;
  top100Pct: number;
  /** Delta vs prior week (positive = more concentrated). null on first run. */
  top10PctDelta: number | null;
  top50PctDelta: number | null;
  top100PctDelta: number | null;
}

/** Top-level shape of pipeline/out/weekly.json. */
export interface WeeklyReport {
  /** Mint address of the tracked token. */
  mint: string;
  /** ISO 8601 timestamp this report was generated. */
  generatedAt: string;
  /** ISO 8601 timestamp of the snapshot used. */
  snapshotDate: string;
  /** ISO 8601 timestamp of the prior snapshot (null on first run). */
  priorSnapshotDate: string | null;
  /** Token decimal places (needed by consumers to format raw amounts). */
  decimals: number;
  /** Live market data at report generation time. null if DexScreener was unreachable. */
  market: MarketData | null;
  /**
   * Top-20 holders after filtering (lp/burn/exchange/bridge/bot excluded)
   * and cluster collapsing.
   */
  holders: RankedHolder[];
  /** Top-20 wallets by positive balance delta this week. Custodial excluded. */
  topAccumulators: DiffEntry[];
  /** Top-20 wallets by negative balance delta this week. Custodial excluded. */
  topDistributors: DiffEntry[];
  /** Wallets that entered the filtered top-100 this week. */
  newInTop100: MovementEntry[];
  /** Wallets that dropped out of the filtered top-100 this week. */
  exitedTop100: MovementEntry[];
  /** Concentration metrics with week-over-week deltas. */
  concentration: ConcentrationStats;
  /** Total supply raw (bigint as string). */
  totalSupplyRaw: string;
  /** Number of unique holders before any filtering. */
  holderCountRaw: number;
  /** Number of distinct entities after filtering and cluster collapsing. */
  holderCountFiltered: number;
}
