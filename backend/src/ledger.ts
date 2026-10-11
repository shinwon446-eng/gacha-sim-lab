/**
 * Authoritative ledger. Every money movement is one wallet_transactions row plus
 * append-only ledger_entries, written in the same database transaction as the
 * accounts balance cache, the order and the inventory it pays for.
 *
 * The catalogue, draw mapping, funding lineage and rollover weights are imported
 * from web/lib so the server resolves exactly what the published odds describe.
 */
import { randomUUID } from "node:crypto";
import { CATALOG_ODDS_VERSION, dropTable, floorRatio, getBoxBySlug, sellValueOf } from "../../web/lib/products";
import { calculateRollResult, determineItem, generateClientSeed, generateServerSeed, hashServerSeed } from "../../web/lib/fairness";
import { rolloverContribution } from "../../web/lib/rollover";
import { tierOf } from "../../web/lib/tiers";
import { num, type Db, type Queryable } from "./db.js";
import { HttpError } from "./errors.js";

export const MAX_OPEN_QUANTITY = 100;
export const MAX_SELL_ITEMS = 200;
export const DEPOSIT_NETWORKS = ["TRC20", "BEP20", "ERC20"] as const;

/** USDT (2 decimals) → integer cents. Rejects values that are not whole cents. */
export function toCents(usdt: number): number {
  const c = Math.round(usdt * 100);
  if (!Number.isFinite(usdt) || Math.abs(usdt * 100 - c) > 1e-6) throw new HttpError(400, "invalid_amount");
  return c;
}
export const toUsdt = (cents: number): number => cents / 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestIdOf(body: Record<string, unknown>): string {
  const id = body.requestId;
  if (typeof id !== "string" || id.length < 8 || id.length > 100 || !/^[\w:.-]+$/.test(id)) throw new HttpError(400, "invalid_request_id");
  return id;
}

/**
 * Claims (user, requestId) inside the caller's transaction. Returns the stored
 * response when the same request already committed; a concurrent duplicate blocks
 * on the primary key until the first commits. A failed operation rolls the claim back.
 */
async function claim(q: Queryable, userId: string, requestId: string, fingerprint: string): Promise<unknown | null> {
  const fresh = await q.query("INSERT INTO idempotency_keys (user_id, request_id, fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING request_id", [userId, requestId, fingerprint]);
  if (fresh.rows.length) return null;
  const prev = (await q.query<{ fingerprint: string; response: unknown }>("SELECT fingerprint, response FROM idempotency_keys WHERE user_id = $1 AND request_id = $2", [userId, requestId])).rows[0];
  if (!prev || prev.fingerprint !== fingerprint) throw new HttpError(409, "request_id_reused");
  if (prev.response == null) throw new HttpError(409, "request_in_progress");
  return prev.response;
}

const remember = (q: Queryable, userId: string, requestId: string, response: unknown) =>
  q.query("UPDATE idempotency_keys SET response = $3::jsonb WHERE user_id = $1 AND request_id = $2", [userId, requestId, JSON.stringify(response)]);

interface AccountRow { crypto: number; card: number; depositedCrypto: number; depositedCard: number; wagered: number }

/** Row lock on the account serializes every balance change of one user. */
async function lockAccount(q: Queryable, userId: string): Promise<AccountRow> {
  await q.query("INSERT INTO accounts (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  const r = (await q.query<Record<string, unknown>>(
    "SELECT crypto_cents, card_cents, deposited_crypto_cents, deposited_card_cents, wagered_cents FROM accounts WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
  return { crypto: num(r.crypto_cents), card: num(r.card_cents), depositedCrypto: num(r.deposited_crypto_cents), depositedCard: num(r.deposited_card_cents), wagered: num(r.wagered_cents) };
}

/** Records one business operation and its per-bucket entries. Zero-amount legs are skipped. */
async function post(q: Queryable, userId: string, tx: { type: string; amountCents: number; ref?: string; network?: string; rolloverCents?: number }, legs: { crypto?: number; card?: number }): Promise<string> {
  const id = randomUUID();
  await q.query("INSERT INTO wallet_transactions (id, user_id, type, amount_cents, ref, network, rollover_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, userId, tx.type, tx.amountCents, tx.ref ?? null, tx.network ?? null, tx.rolloverCents ?? null]);
  for (const bucket of ["crypto", "card"] as const) {
    const amount = legs[bucket] ?? 0;
    if (amount !== 0) await q.query("INSERT INTO ledger_entries (user_id, tx_id, bucket, amount_cents) VALUES ($1, $2, $3, $4)", [userId, id, bucket, amount]);
  }
  return id;
}

async function saveAccount(q: Queryable, userId: string, a: AccountRow): Promise<void> {
  await q.query(
    `UPDATE accounts SET crypto_cents = $2, card_cents = $3, deposited_crypto_cents = $4, deposited_card_cents = $5, wagered_cents = $6, updated_at = now() WHERE user_id = $1`,
    [userId, a.crypto, a.card, a.depositedCrypto, a.depositedCard, a.wagered]);
}

/** Same split as lib/funding.ts attributeRefund, in cents: rounding goes to the card bucket. */
function attribute(amount: number, ratioCrypto: number): { crypto: number; card: number } {
  const crypto = Math.round(amount * Math.min(1, Math.max(0, ratioCrypto)));
  return { crypto, card: amount - crypto };
}

export interface WalletSnapshot {
  cryptoBalance: number; cardBalance: number; balance: number;
  totalDepositedCrypto: number; totalDepositedCard: number; totalDeposited: number; totalWagered: number;
}

const snapshotOf = (a: AccountRow): WalletSnapshot => ({
  cryptoBalance: toUsdt(a.crypto), cardBalance: toUsdt(a.card), balance: toUsdt(a.crypto + a.card),
  totalDepositedCrypto: toUsdt(a.depositedCrypto), totalDepositedCard: toUsdt(a.depositedCard),
  totalDeposited: toUsdt(a.depositedCrypto + a.depositedCard), totalWagered: toUsdt(a.wagered),
});

export async function wallet(db: Db, userId: string) {
  const a = (await db.query<Record<string, unknown>>(
    "SELECT crypto_cents, card_cents, deposited_crypto_cents, deposited_card_cents, wagered_cents FROM accounts WHERE user_id = $1", [userId])).rows[0];
  const account: AccountRow = a
    ? { crypto: num(a.crypto_cents), card: num(a.card_cents), depositedCrypto: num(a.deposited_crypto_cents), depositedCard: num(a.deposited_card_cents), wagered: num(a.wagered_cents) }
    : { crypto: 0, card: 0, depositedCrypto: 0, depositedCard: 0, wagered: 0 };
  const txs = (await db.query<Record<string, unknown>>(
    "SELECT id, type, amount_cents, status, ref, network, rollover_cents, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 100", [userId])).rows;
  return {
    ...snapshotOf(account),
    transactions: txs.map((t) => ({
      id: t.id as string, type: t.type as string, amountUsdt: toUsdt(num(t.amount_cents)), status: t.status as string,
      at: new Date(t.created_at as string).toISOString(),
      ...(t.ref ? { ref: t.ref as string } : {}), ...(t.network ? { network: t.network as string } : {}),
      ...(t.rollover_cents != null ? { rolloverUsdt: toUsdt(num(t.rollover_cents)) } : {}),
    })),
  };
}

// ── Draw seeds ──────────────────────────────────────────────────────────────

interface SeedRow { id: string; server_seed: string; server_seed_hash: string; client_seed: string; next_nonce: number; retired_at: unknown }

const publicSeed = (s: SeedRow) => ({ seedId: s.id, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, nextNonce: num(s.next_nonce) });

function checkClientSeed(raw: unknown): string {
  if (typeof raw !== "string" || !/^[\x21-\x7e]{1,64}$/.test(raw)) throw new HttpError(400, "invalid_client_seed");
  return raw;
}

async function insertSeed(q: Queryable, userId: string, clientSeed: string): Promise<void> {
  const serverSeed = generateServerSeed();
  await q.query(
    `INSERT INTO fair_seeds (id, user_id, server_seed, server_seed_hash, client_seed) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) WHERE retired_at IS NULL DO NOTHING`,
    [randomUUID(), userId, serverSeed, await hashServerSeed(serverSeed), clientSeed]);
}

async function activeSeed(q: Queryable, userId: string, lock: boolean): Promise<SeedRow> {
  const select = `SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, retired_at FROM fair_seeds WHERE user_id = $1 AND retired_at IS NULL${lock ? " FOR UPDATE" : ""}`;
  let row = (await q.query<SeedRow>(select, [userId])).rows[0];
  if (!row) {
    await insertSeed(q, userId, generateClientSeed());
    row = (await q.query<SeedRow>(select, [userId])).rows[0];
  }
  return row;
}

/** The commitment shown before an opening. The server seed itself never leaves until retired. */
export async function currentSeed(db: Db, userId: string) {
  return publicSeed(await activeSeed(db, userId, false));
}

/** Retires the active seed (revealing it) and starts a new one, optionally with a user-chosen client seed. */
export async function rotateSeed(db: Db, userId: string, body: Record<string, unknown>) {
  const clientSeed = body.clientSeed === undefined ? generateClientSeed() : checkClientSeed(body.clientSeed);
  return db.tx(async (q) => {
    await lockAccount(q, userId); // no opening can use the seed while it is being revealed
    const old = await activeSeed(q, userId, true);
    await q.query("UPDATE fair_seeds SET retired_at = now() WHERE id = $1", [old.id]);
    await insertSeed(q, userId, clientSeed);
    const next = await activeSeed(q, userId, false);
    return { revealed: { ...publicSeed(old), serverSeed: old.server_seed }, current: publicSeed(next) };
  });
}

export async function seedById(db: Db, userId: string, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, "not_found");
  const s = (await db.query<SeedRow>("SELECT id, server_seed, server_seed_hash, client_seed, next_nonce, retired_at FROM fair_seeds WHERE id = $1 AND user_id = $2", [id, userId])).rows[0];
  if (!s) throw new HttpError(404, "not_found");
  return s.retired_at ? { ...publicSeed(s), serverSeed: s.server_seed, retired: true } : { ...publicSeed(s), retired: false };
}

// ── Opening ─────────────────────────────────────────────────────────────────

/**
 * One purchase: debit, draw, inventory and instant cashback commit together or not at all.
 * A repeated requestId returns the first response without charging again.
 */
export async function openBoxes(db: Db, userId: string, body: Record<string, unknown>) {
  const box = typeof body.boxSlug === "string" ? getBoxBySlug(body.boxSlug) : undefined;
  if (!box) throw new HttpError(400, "invalid_box");
  const quantity = body.quantity;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_OPEN_QUANTITY) throw new HttpError(400, "invalid_quantity");
  const requestId = requestIdOf(body);

  return db.tx(async (q) => {
    const replay = await claim(q, userId, requestId, `open:${box.slug}:${quantity}`);
    if (replay) return replay;

    const account = await lockAccount(q, userId);
    const priceCents = toCents(box.price);
    const cost = priceCents * quantity;
    if (account.crypto + account.card < cost) {
      throw new HttpError(409, "insufficient_balance", { costUsdt: toUsdt(cost), balanceUsdt: toUsdt(account.crypto + account.card), shortfallUsdt: toUsdt(cost - account.crypto - account.card) });
    }
    // Crypto first, card for the rest (lib/funding.ts planDebit).
    const fromCrypto = Math.min(account.crypto, cost);
    const fromCard = cost - fromCrypto;
    const ratioCrypto = +(fromCrypto / cost).toFixed(6);

    const seed = await activeSeed(q, userId, true);
    const firstNonce = num(seed.next_nonce);
    await q.query("UPDATE fair_seeds SET next_nonce = next_nonce + $2 WHERE id = $1", [seed.id, quantity]);
    const table = dropTable(box);
    const draws = await Promise.all(Array.from({ length: quantity }, async (_, i) => {
      const nonce = firstNonce + i;
      const { roll } = await calculateRollResult(seed.server_seed, seed.client_seed, nonce);
      const item = determineItem(roll, table);
      return { nonce, roll, item, tier: tierOf(item.value, box.price).key };
    }));

    const rolloverCents = toCents(rolloverContribution(toUsdt(cost), floorRatio(box)));
    const openTx = await post(q, userId, { type: "open", amountCents: -cost, ref: `${box.slug}x${quantity}`, rolloverCents }, { crypto: -fromCrypto, card: -fromCard });
    const orderId = randomUUID();
    await q.query(
      `INSERT INTO orders (id, user_id, box_slug, quantity, price_cents, cost_cents, from_crypto_cents, from_card_cents, odds_version, drop_table, seed_id, tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [orderId, userId, box.slug, quantity, priceCents, cost, fromCrypto, fromCard, CATALOG_ODDS_VERSION,
        JSON.stringify(table.map(({ id, dropRate }) => ({ id, dropRate }))), seed.id, openTx]);

    // Cash results settle immediately at 100%, back to the buckets that paid for them.
    const cashBack = { crypto: 0, card: 0 };
    const results = [];
    for (const d of draws) {
      const id = randomUUID();
      const valueCents = toCents(d.item.value);
      const settled = d.item.kind === "cash";
      await q.query(
        `INSERT INTO inventory_items (id, user_id, order_id, item_id, box_slug, kind, value_cents, tier, status, ratio_crypto, nonce, roll, sold_at, sold_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${settled ? "now()" : "NULL"}, $13)`,
        [id, userId, orderId, d.item.id, box.slug, d.item.kind, valueCents, d.tier, settled ? "SOLD" : "IN_STORAGE", ratioCrypto, d.nonce, d.roll, settled ? valueCents : null]);
      if (settled) {
        const split = attribute(valueCents, ratioCrypto);
        cashBack.crypto += split.crypto;
        cashBack.card += split.card;
      }
      results.push({ ownedId: id, itemId: d.item.id, kind: d.item.kind, valueUsdt: d.item.value, tier: d.tier, settled, nonce: d.nonce, roll: d.roll });
    }
    const cashTotal = cashBack.crypto + cashBack.card;
    if (cashTotal > 0) await post(q, userId, { type: "sellback", amountCents: cashTotal, ref: `${box.slug}:cashback x${results.filter((r) => r.settled).length}` }, cashBack);

    account.crypto += cashBack.crypto - fromCrypto;
    account.card += cashBack.card - fromCard;
    account.wagered += rolloverCents;
    await saveAccount(q, userId, account);

    const response = {
      orderId, boxSlug: box.slug, quantity, costUsdt: toUsdt(cost), oddsVersion: CATALOG_ODDS_VERSION,
      fair: { seedId: seed.id, serverSeedHash: seed.server_seed_hash, clientSeed: seed.client_seed },
      results, wallet: snapshotOf(account),
    };
    await remember(q, userId, requestId, response);
    return response;
  });
}

// ── Inventory ───────────────────────────────────────────────────────────────

export async function inventory(db: Db, userId: string) {
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT i.id, i.item_id, i.box_slug, i.kind, i.value_cents, i.tier, i.status, i.ratio_crypto, i.nonce, i.roll, i.created_at, i.sold_at, i.sold_cents,
            o.seed_id, o.odds_version
     FROM inventory_items i JOIN orders o ON o.id = i.order_id WHERE i.user_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 500`, [userId])).rows;
  return rows.map((r) => ({
    id: r.id as string, itemId: r.item_id as string, boxSlug: r.box_slug as string, kind: r.kind as string,
    valueUsdt: toUsdt(num(r.value_cents)), tier: r.tier as string, status: r.status as string,
    fundingRatio: { crypto: Number(r.ratio_crypto), card: +(1 - Number(r.ratio_crypto)).toFixed(6) },
    acquiredAt: new Date(r.created_at as string).toISOString(),
    ...(r.sold_at ? { soldAt: new Date(r.sold_at as string).toISOString(), soldUsdt: toUsdt(num(r.sold_cents)) } : {}),
    fair: { seedId: r.seed_id as string, nonce: num(r.nonce), roll: num(r.roll), oddsVersion: r.odds_version as string },
  }));
}

/** 95% payback of stored items, credited back to the buckets in each item's funding lineage. */
export async function sellItems(db: Db, userId: string, body: Record<string, unknown>) {
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SELL_ITEMS || !ids.every((x) => typeof x === "string" && UUID.test(x)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, "invalid_items");
  }
  const requestId = requestIdOf(body);
  return db.tx(async (q) => {
    const replay = await claim(q, userId, requestId, `sell:${[...ids].sort().join(",")}`);
    if (replay) return replay;
    const account = await lockAccount(q, userId);
    const rows = (await q.query<Record<string, unknown>>(
      "SELECT id, kind, value_cents, status, ratio_crypto FROM inventory_items WHERE user_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [userId, ids])).rows;
    if (rows.length !== ids.length) throw new HttpError(404, "not_found");
    if (rows.some((r) => r.status !== "IN_STORAGE")) throw new HttpError(409, "already_processed");
    const credit = { crypto: 0, card: 0 };
    for (const r of rows) {
      const sold = toCents(sellValueOf({ kind: r.kind as "physical", value: toUsdt(num(r.value_cents)) }));
      const split = attribute(sold, Number(r.ratio_crypto));
      credit.crypto += split.crypto;
      credit.card += split.card;
      await q.query("UPDATE inventory_items SET status = 'SOLD', sold_at = now(), sold_cents = $2 WHERE id = $1", [r.id, sold]);
    }
    const total = credit.crypto + credit.card;
    await post(q, userId, { type: "sellback", amountCents: total, ref: `sell x${rows.length}` }, credit);
    account.crypto += credit.crypto;
    account.card += credit.card;
    await saveAccount(q, userId, account);
    const response = { ids, totalUsdt: toUsdt(total), toCrypto: toUsdt(credit.crypto), toCard: toUsdt(credit.card), wallet: snapshotOf(account) };
    await remember(q, userId, requestId, response);
    return response;
  });
}

// ── Deposits ────────────────────────────────────────────────────────────────

/**
 * Credits a confirmed crypto deposit. Phase 1 reaches this only through the
 * development credit route; the chain watcher (/deposit/check) calls it in a later phase.
 */
export async function creditDeposit(db: Db, userId: string, body: Record<string, unknown>) {
  const network = body.network;
  if (typeof network !== "string" || !(DEPOSIT_NETWORKS as readonly string[]).includes(network)) throw new HttpError(400, "invalid_network");
  if (typeof body.amountUsdt !== "number" || body.amountUsdt < 1 || body.amountUsdt > 1_000_000) throw new HttpError(400, "invalid_amount");
  const amount = toCents(body.amountUsdt);
  const requestId = requestIdOf(body);
  return db.tx(async (q) => {
    const replay = await claim(q, userId, requestId, `deposit:${network}:${amount}`);
    if (replay) return replay;
    const account = await lockAccount(q, userId);
    const txId = await post(q, userId, { type: "deposit_usdt", amountCents: amount, network }, { crypto: amount });
    account.crypto += amount;
    account.depositedCrypto += amount;
    await saveAccount(q, userId, account);
    const response = { transactionId: txId, amountUsdt: toUsdt(amount), wallet: snapshotOf(account) };
    await remember(q, userId, requestId, response);
    return response;
  });
}
