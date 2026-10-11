/**
 * Phase-1 accounts: email + password signup with a six-digit email code, login,
 * cookie session, logout. OAuth, TOTP and password reset follow in later phases.
 */
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { HttpError } from "./errors.js";

export const SESSION_DAYS = 30;
export const CODE_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const AuthError = HttpError;

export interface Mailer {
  sendVerificationCode(email: string, code: string): Promise<void>;
}

export interface User { id: string; email: string; emailVerified: true; createdAt: string; nickname?: string }

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (): string => randomBytes(32).toString("base64url");

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "invalid_email");
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, "invalid_email");
  return email;
}

function checkPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) throw new AuthError(400, "invalid_password");
  return raw;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scryptAsync(password, salt)).toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Spends the same scrypt time for unknown emails so login timing does not reveal accounts.
let dummyHash: Promise<string> | undefined;

const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

async function issueCode(q: Queryable, mailer: Mailer, email: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await q.query(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts) VALUES ($1, $2, now() + make_interval(mins => $3), 0)
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [email, codeHash(email, code), CODE_MINUTES],
  );
  await mailer.sendVerificationCode(email, code);
}

/** Same response whether or not the email exists, so signup does not reveal accounts. */
export async function signup(db: Db, mailer: Mailer, body: Record<string, unknown>): Promise<void> {
  const email = normalizeEmail(body.email);
  const password = checkPassword(body.password);
  if (body.acceptedTerms !== true) throw new AuthError(400, "terms_required");
  const passwordHash = await hashPassword(password);
  const existing = (await db.query<{ email_verified: boolean }>("SELECT email_verified FROM users WHERE email = $1", [email])).rows[0];
  if (existing?.email_verified) return;
  if (existing) await db.query("UPDATE users SET password_hash = $2 WHERE email = $1", [email, passwordHash]);
  else await db.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING", [randomUUID(), email, passwordHash]);
  await issueCode(db, mailer, email);
}

export async function resendCode(db: Db, mailer: Mailer, body: Record<string, unknown>): Promise<void> {
  const email = normalizeEmail(body.email);
  const user = (await db.query<{ email_verified: boolean }>("SELECT email_verified FROM users WHERE email = $1", [email])).rows[0];
  if (user && !user.email_verified) await issueCode(db, mailer, email);
}

/** Consumes the code once. Returns the user id; the caller then opens a session. */
export async function verifyEmail(db: Db, body: Record<string, unknown>): Promise<string> {
  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  return db.tx(async (q) => {
    const row = (await q.query<{ code_hash: string; expired: boolean; attempts: number }>(
      "SELECT code_hash, expires_at < now() AS expired, attempts FROM email_codes WHERE email = $1 FOR UPDATE", [email])).rows[0];
    if (!row || row.expired) throw new AuthError(401, "invalid_code");
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AuthError(429, "too_many_attempts");
    const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(codeHash(email, code)), Buffer.from(row.code_hash));
    if (!ok) {
      await q.query("UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
      return "";
    }
    await q.query("DELETE FROM email_codes WHERE email = $1", [email]);
    const user = (await q.query<{ id: string }>("UPDATE users SET email_verified = TRUE WHERE email = $1 RETURNING id", [email])).rows[0];
    if (!user) throw new AuthError(401, "invalid_code");
    await q.query("INSERT INTO accounts (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);
    return user.id;
  }).then((id) => {
    // A wrong code must still commit the attempt counter, so it is reported after the transaction.
    if (!id) throw new AuthError(401, "invalid_code");
    return id;
  });
}

export async function login(db: Db, body: Record<string, unknown>): Promise<string> {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const user = (await db.query<{ id: string; password_hash: string; email_verified: boolean }>(
    "SELECT id, password_hash, email_verified FROM users WHERE email = $1", [email])).rows[0];
  if (!user) {
    dummyHash ??= hashPassword(randomToken());
    await verifyPassword(password, await dummyHash);
    throw new AuthError(401, "invalid_credentials");
  }
  if (!(await verifyPassword(password, user.password_hash))) throw new AuthError(401, "invalid_credentials");
  if (!user.email_verified) throw new AuthError(403, "email_unverified");
  return user.id;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [sha256(token), userId, SESSION_DAYS]);
  return token;
}

export async function sessionUser(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const row = (await db.query<{ id: string; email: string; created_at: Date | string; nickname: string | null }>(
    `SELECT u.id, u.email, u.created_at, u.nickname FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.email_verified`, [sha256(token)])).rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, emailVerified: true, createdAt: new Date(row.created_at).toISOString(), ...(row.nickname ? { nickname: row.nickname } : {}) };
}

export async function revokeSession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(token)]);
}
