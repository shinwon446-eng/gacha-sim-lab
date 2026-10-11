import { createApp, type Config } from "../src/app.js";
import { openPglite, type Db } from "../src/db.js";

export const ORIGIN = "http://localhost:3001";

export async function setup(overrides: Partial<Config> = {}) {
  const db = await openPglite();
  const codes = new Map<string, string>();
  const app = createApp(db, { sendVerificationCode: async (email, code) => void codes.set(email, code) },
    { allowedOrigins: [ORIGIN], secureCookies: false, devCredit: true, ...overrides });
  return { db, app, codes };
}

/** Browser-like client: keeps cookies, fetches the CSRF token before each mutation. */
export function client(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(line) || value === "") jar.delete(name); else jar.set(name, value);
    }
  };
  const raw = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { Origin: ORIGIN, Cookie: cookieHeader(), ...(init.headers ?? {}) } });
    store(res);
    return res;
  };
  const get = async (path: string) => {
    const res = await raw(path);
    return { status: res.status, body: await res.json() as any };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const { token } = (await get("/auth/csrf")).body;
    const res = await raw(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  return { raw, get, post, jar };
}

export const PASSWORD = "correct horse battery";

/** Signs up, verifies by the mailed code and returns a logged-in client. */
export async function member(env: Awaited<ReturnType<typeof setup>>, email = `u${Math.random().toString(36).slice(2)}@example.com`) {
  const c = client(env.app);
  await c.post("/auth/signup", { email, password: PASSWORD, locale: "ko", acceptedTerms: true });
  const verified = await c.post("/auth/email/verify", { email, code: env.codes.get(email) });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  return Object.assign(c, { email, userId: verified.body.user.id as string });
}

let n = 0;
export const rid = () => `req-${Date.now()}-${n++}`;

/** accounts cache must equal the sum of the append-only ledger, per bucket. */
export async function ledgerMatches(db: Db, userId: string) {
  const sums = (await db.query<{ bucket: string; total: unknown }>("SELECT bucket, COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE user_id = $1 GROUP BY bucket", [userId])).rows;
  const acct = (await db.query<{ crypto_cents: unknown; card_cents: unknown }>("SELECT crypto_cents, card_cents FROM accounts WHERE user_id = $1", [userId])).rows[0];
  const of = (b: string) => Number(sums.find((s) => s.bucket === b)?.total ?? 0);
  return of("crypto") === Number(acct.crypto_cents) && of("card") === Number(acct.card_cents);
}
