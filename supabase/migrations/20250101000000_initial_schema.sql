-- =============================================================================
-- Initial schema for cate-analytics
-- =============================================================================
-- Design notes:
--   - Amounts are stored as `numeric` (arbitrary precision) to match on-chain
--     bigint values; never float.
--   - Addresses are case-sensitive base58 text; never lowercased.
--   - Snapshots are immutable once written; corrections go in wallet_labels.
--   - holder_balances rows are aggregated per owner (one row per snapshot+owner).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------

CREATE TYPE wallet_label_kind AS ENUM (
  'lp',
  'burn',
  'exchange',
  'bridge',
  'bot',
  'cluster',
  'custodial',
  'manual'
);

-- ---------------------------------------------------------------------------
-- snapshots
-- One row per weekly pipeline run. Immutable after insert.
-- ---------------------------------------------------------------------------

CREATE TABLE snapshots (
  id           bigserial    PRIMARY KEY,
  taken_at     timestamptz  NOT NULL,
  mint         text         NOT NULL,  -- base58 token mint address
  holder_count integer      NOT NULL,  -- raw holder count before any filtering
  total_supply numeric      NOT NULL   -- raw supply in mint's smallest unit
);

-- Prevent duplicate runs for the same mint at the same moment.
CREATE UNIQUE INDEX ON snapshots (mint, taken_at);

-- Fast retrieval of latest snapshot(s) per mint (used by holder_diff view).
CREATE INDEX ON snapshots (mint, taken_at DESC);

-- ---------------------------------------------------------------------------
-- holder_balances
-- Aggregated per owner — one row per (snapshot, owner).
-- token_account is stored as the representative/primary account for
-- traceability back to on-chain data; amounts are already summed across all
-- token accounts owned by this address.
-- ---------------------------------------------------------------------------

CREATE TABLE holder_balances (
  snapshot_id   bigint   NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  owner         text     NOT NULL,  -- base58 owner address
  token_account text     NOT NULL,  -- representative token account
  amount        numeric  NOT NULL,  -- raw balance in mint's smallest unit
  rank          integer  NOT NULL,  -- 1-based rank after aggregation
  PRIMARY KEY (snapshot_id, owner)
);

-- Enables cross-snapshot joins in holder_diff (joining on owner across two
-- different snapshot_ids). Without this, the join degrades to a seq scan on
-- every query of the view.
CREATE INDEX ON holder_balances (owner);

-- ---------------------------------------------------------------------------
-- wallet_labels
-- One label per owner. Corrections update this row; never edit
-- holder_balances to fix a misclassification.
-- ---------------------------------------------------------------------------

CREATE TABLE wallet_labels (
  owner      text               PRIMARY KEY,  -- base58 address
  label      text,                            -- human-readable name, e.g. "Raydium LP v4"
  kind       wallet_label_kind  NOT NULL,
  source     text               NOT NULL,     -- "dexscreener" | "manual" | "cluster" | …
  notes      text,                            -- free-form; nullable
  created_at timestamptz        NOT NULL DEFAULT now()
);

-- The holder_diff view filters on kind; an index avoids a seq scan on the
-- exclusion subquery for every diff lookup.
CREATE INDEX ON wallet_labels (kind);

-- ---------------------------------------------------------------------------
-- wallet_clusters
-- Tracks wallets linked by a common funder. Each wallet belongs to at most
-- one cluster. cluster_id is conventionally the funder's base58 address.
-- ---------------------------------------------------------------------------

CREATE TABLE wallet_clusters (
  owner      text         PRIMARY KEY,  -- base58 address of the cluster member
  funder     text         NOT NULL,     -- base58 address of the common funder
  cluster_id text         NOT NULL,     -- identifier shared by all cluster members
  created_at timestamptz  NOT NULL DEFAULT now()
);

-- Look up all members of a cluster in one scan.
CREATE INDEX ON wallet_clusters (cluster_id);

-- ---------------------------------------------------------------------------
-- subscribers
-- Newsletter subscriber list for Resend broadcasts.
-- confirmed_at NULL  → pending confirmation
-- unsubscribed_at NOT NULL → opted out
-- ---------------------------------------------------------------------------

CREATE TABLE subscribers (
  email            text         PRIMARY KEY,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,   -- NULL until double-opt-in confirmed
  unsubscribed_at  timestamptz    -- NULL while still subscribed
);

-- ---------------------------------------------------------------------------
-- holder_diff view
-- Diffs the two most recent snapshots per mint.
--
-- Exclusion rules (matching CLAUDE.md):
--   lp, burn, exchange, bridge, bot  → excluded entirely
--   cluster                          → collapsed to one entity (shown, not excluded)
--   custodial                        → shown but flagged (not excluded here)
--
-- rank_delta: positive = moved up in ranking (e.g. prior rank 10 → current
--   rank 3 gives delta = +7), matching RankedHolder.rankDelta in types.ts.
-- balance_delta: current_amount - prior_amount (positive = accumulated).
-- New entrants have NULL prior_rank and NULL rank_delta.
-- ---------------------------------------------------------------------------

CREATE VIEW holder_diff AS
WITH snap_ranks AS (
  -- Rank all snapshots per mint, newest first.
  SELECT
    id,
    mint,
    DENSE_RANK() OVER (PARTITION BY mint ORDER BY taken_at DESC) AS snap_rank
  FROM snapshots
),
current_snap AS (
  SELECT id, mint FROM snap_ranks WHERE snap_rank = 1
),
prior_snap AS (
  SELECT id, mint FROM snap_ranks WHERE snap_rank = 2
),
excluded AS (
  -- Owners that should be hidden from the diff entirely.
  SELECT owner
  FROM wallet_labels
  WHERE kind IN ('lp', 'burn', 'exchange', 'bridge', 'bot')
)
SELECT
  cs.mint,
  hc.owner,
  hc.rank                                         AS current_rank,
  hc.amount                                       AS current_amount,
  hp.rank                                         AS prior_rank,
  hp.amount                                       AS prior_amount,
  hc.amount - COALESCE(hp.amount, 0)              AS balance_delta,
  CASE
    WHEN hp.rank IS NULL THEN NULL          -- new entrant this week
    ELSE hp.rank - hc.rank                  -- positive = moved up
  END                                             AS rank_delta
FROM holder_balances hc
JOIN  current_snap cs ON hc.snapshot_id = cs.id
-- prior_snap may not exist (first run); LEFT JOIN keeps current rows visible.
LEFT JOIN prior_snap ps ON ps.mint = cs.mint
LEFT JOIN holder_balances hp
  ON  hp.owner       = hc.owner
  AND hp.snapshot_id = ps.id
WHERE hc.owner NOT IN (SELECT owner FROM excluded)
ORDER BY hc.rank;
