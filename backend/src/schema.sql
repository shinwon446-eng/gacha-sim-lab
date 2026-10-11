-- VOILA server ledger, phase 1. Idempotent: runs on every start.
-- Money is integer cents (USDT × 100). Floats never touch a balance.

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,          -- lower-cased, trimmed
  password_hash   TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  nickname        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                  -- SHA-256 of the cookie value; the raw token is never stored
  user_id     UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

-- Balance cache. Always equal to the sum of ledger_entries per bucket (tests assert it).
CREATE TABLE IF NOT EXISTS accounts (
  user_id                  UUID PRIMARY KEY REFERENCES users(id),
  crypto_cents             BIGINT NOT NULL DEFAULT 0 CHECK (crypto_cents >= 0),
  card_cents               BIGINT NOT NULL DEFAULT 0 CHECK (card_cents >= 0),
  deposited_crypto_cents   BIGINT NOT NULL DEFAULT 0,
  deposited_card_cents     BIGINT NOT NULL DEFAULT 0,
  wagered_cents            BIGINT NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per business operation, shaped like the client's Transaction history.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL,                 -- deposit_usdt | open | sellback | ...
  amount_cents    BIGINT NOT NULL,               -- signed: + credit, - debit
  status          TEXT NOT NULL DEFAULT 'COMPLETED',
  ref             TEXT,
  network         TEXT,
  rollover_cents  BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_transactions_user ON wallet_transactions (user_id, created_at DESC);

-- Append-only. Never updated or deleted.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  tx_id         UUID NOT NULL REFERENCES wallet_transactions(id),
  bucket        TEXT NOT NULL CHECK (bucket IN ('crypto', 'card')),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents <> 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_user ON ledger_entries (user_id);

-- A repeated requestId returns the stored response instead of charging again.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       UUID NOT NULL REFERENCES users(id),
  request_id    TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,                   -- operation + parameters; a reused id with other parameters is rejected
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

-- Server-held draw seeds. server_seed leaves the server only after retired_at is set.
CREATE TABLE IF NOT EXISTS fair_seeds (
  id                UUID PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id),
  server_seed       TEXT NOT NULL,
  server_seed_hash  TEXT NOT NULL,
  client_seed       TEXT NOT NULL,
  next_nonce        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS fair_seeds_active ON fair_seeds (user_id) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id),
  box_slug            TEXT NOT NULL,
  quantity            INT NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  price_cents         BIGINT NOT NULL,
  cost_cents          BIGINT NOT NULL,
  from_crypto_cents   BIGINT NOT NULL,
  from_card_cents     BIGINT NOT NULL,
  odds_version        TEXT NOT NULL,
  drop_table          JSONB NOT NULL,            -- exact ordered odds snapshot used for this order
  seed_id             UUID NOT NULL REFERENCES fair_seeds(id),
  tx_id               UUID NOT NULL REFERENCES wallet_transactions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id                 UUID PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id),
  order_id           UUID NOT NULL REFERENCES orders(id),
  item_id            TEXT NOT NULL,
  box_slug           TEXT NOT NULL,
  kind               TEXT NOT NULL,
  value_cents        BIGINT NOT NULL,
  tier               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('IN_STORAGE', 'SOLD')),
  ratio_crypto       DOUBLE PRECISION NOT NULL,   -- funding lineage (lib/funding.ts), 0..1
  nonce              INT NOT NULL,
  roll               INT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_at            TIMESTAMPTZ,
  sold_cents         BIGINT
);
CREATE INDEX IF NOT EXISTS inventory_items_user ON inventory_items (user_id, created_at DESC);
