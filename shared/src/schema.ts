import { z } from "zod";

export const WalletLabelKindSchema = z.enum([
  "lp",
  "burn",
  "exchange",
  "bridge",
  "bot",
  "cluster",
  "custodial",
  "manual",
]);

export const MarketDataSchema = z.object({
  priceUsd: z.number().nonnegative(),
  priceChange24h: z.number().nullable(),
  priceChange7d: z.number().nullable(),
  volumeUsd24h: z.number().nonnegative().nullable(),
  marketCapUsd: z.number().nonnegative().nullable(),
  liquidityUsd: z.number().nonnegative().nullable(),
  fetchedAt: z.string().datetime(),
});

export const RankedHolderSchema = z.object({
  rank: z.number().int().positive(),
  owner: z.string().min(32).max(44),
  balance: z.string(),
  balanceRaw: z.string(),
  balanceUsd: z.number().nullable(),
  pct: z.number().min(0).max(100),
  rankDelta: z.number().int().nullable(),
  balanceDelta: z.string(),
  balanceDeltaFormatted: z.string(),
  balanceDeltaUsd: z.number().nullable(),
  label: WalletLabelKindSchema.optional(),
  note: z.string().optional(),
  isCluster: z.boolean(),
  solscanUrl: z.string().url(),
});

export const DiffEntrySchema = z.object({
  rank: z.number().int().positive(),
  owner: z.string().min(32).max(44),
  solscanUrl: z.string().url(),
  balance: z.string(),
  balanceRaw: z.string(),
  balanceUsd: z.number().nullable(),
  pct: z.number().min(0).max(100),
  balanceDelta: z.string(),
  balanceDeltaFormatted: z.string(),
  balanceDeltaUsd: z.number().nullable(),
  label: WalletLabelKindSchema.optional(),
  note: z.string().optional(),
  isCluster: z.boolean(),
});

export const MovementEntrySchema = z.object({
  owner: z.string().min(32).max(44),
  solscanUrl: z.string().url(),
  currentRank: z.number().int().positive().nullable(),
  priorRank: z.number().int().positive().nullable(),
  balance: z.string(),
  balanceRaw: z.string(),
  balanceUsd: z.number().nullable(),
  pct: z.number().min(0).max(100),
  label: WalletLabelKindSchema.optional(),
  note: z.string().optional(),
  isCluster: z.boolean(),
});

export const ConcentrationStatsSchema = z.object({
  top10Pct: z.number().min(0).max(100),
  top50Pct: z.number().min(0).max(100),
  top100Pct: z.number().min(0).max(100),
  top10PctDelta: z.number().nullable(),
  top50PctDelta: z.number().nullable(),
  top100PctDelta: z.number().nullable(),
});

export const WeeklyReportSchema = z.object({
  mint: z.string().min(32).max(44),
  generatedAt: z.string().datetime(),
  snapshotDate: z.string().datetime(),
  priorSnapshotDate: z.string().datetime().nullable(),
  decimals: z.number().int().nonnegative(),
  market: MarketDataSchema.nullable(),
  holders: z.array(RankedHolderSchema),
  topAccumulators: z.array(DiffEntrySchema),
  topDistributors: z.array(DiffEntrySchema),
  newInTop100: z.array(MovementEntrySchema),
  exitedTop100: z.array(MovementEntrySchema),
  concentration: ConcentrationStatsSchema,
  totalSupplyRaw: z.string(),
  holderCountRaw: z.number().int().nonnegative(),
  holderCountFiltered: z.number().int().nonnegative(),
});

export type WeeklyReportSchema = z.infer<typeof WeeklyReportSchema>;
