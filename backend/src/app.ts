/**
 * HTTP contract (web/ACCOUNT-WALLET-API.md): JSON bodies, cookie session, CSRF token
 * on every mutation, exact-origin CORS with credentials.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth.js";
import * as ledger from "./ledger.js";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";

export interface Config {
  /** Exact frontend origins allowed to call with credentials, e.g. http://localhost:3001 */
  allowedOrigins: string[];
  /** Secure cookies. Off only for plain-http localhost development. */
  secureCookies: boolean;
  /** Enables POST /dev/deposit. Never on in production. */
  devCredit: boolean;
}

export const SESSION_COOKIE = "voila_sid";
export const CSRF_COOKIE = "voila_csrf";

type Env = { Variables: { user: auth.User } };

export function createApp(db: Db, mailer: auth.Mailer, config: Config) {
  const app = new Hono<Env>();
  const cookieOpts = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" };

  app.use("*", cors({
    origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "X-CSRF-Token"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  }));
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // Mutations need an allowed Origin and the CSRF header matching the CSRF cookie.
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const origin = c.req.header("Origin");
    if (origin && !config.allowedOrigins.includes(origin)) throw new HttpError(403, "origin_rejected");
    const header = c.req.header("X-CSRF-Token") ?? "";
    const cookie = getCookie(c, CSRF_COOKIE) ?? "";
    if (header.length < 16 || header.length !== cookie.length || !timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) throw new HttpError(403, "csrf_rejected");
    return next();
  });

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json");
    return parsed as Record<string, unknown>;
  };

  /** Replaces any previous session cookie (prevents session fixation). */
  const startSession = async (c: Context, userId: string) => {
    await auth.revokeSession(db, getCookie(c, SESSION_COOKIE));
    const sid = await auth.createSession(db, userId);
    setCookie(c, SESSION_COOKIE, sid, { ...cookieOpts, maxAge: auth.SESSION_DAYS * 86400 });
    return c.json({ user: await auth.sessionUser(db, sid) });
  };

  const requireUser = async (c: Context<Env>, next: () => Promise<void>) => {
    const user = await auth.sessionUser(db, getCookie(c, SESSION_COOKIE));
    if (!user) throw new HttpError(401, "unauthenticated");
    c.set("user", user);
    await next();
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/auth/csrf", (c) => {
    let token = getCookie(c, CSRF_COOKIE);
    if (!token || token.length < 16) {
      token = auth.randomToken();
      setCookie(c, CSRF_COOKIE, token, cookieOpts);
    }
    return c.json({ token });
  });

  app.post("/auth/signup", async (c) => {
    await auth.signup(db, mailer, await body(c));
    return c.json({ verificationRequired: true });
  });
  app.post("/auth/email/resend", async (c) => {
    await auth.resendCode(db, mailer, await body(c));
    return c.json({ accepted: true });
  });
  app.post("/auth/email/verify", async (c) => startSession(c, await auth.verifyEmail(db, await body(c))));
  app.post("/auth/login", async (c) => startSession(c, await auth.login(db, await body(c))));
  app.get("/auth/session", requireUser, (c) => c.json({ user: c.get("user") }));
  app.post("/auth/logout", async (c) => {
    await auth.revokeSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return c.json({ loggedOut: true });
  });

  app.get("/wallet", requireUser, async (c) => c.json(await ledger.wallet(db, c.get("user").id)));
  app.get("/inventory", requireUser, async (c) => c.json({ items: await ledger.inventory(db, c.get("user").id) }));
  app.post("/open", requireUser, async (c) => c.json(await ledger.openBoxes(db, c.get("user").id, await body(c))));
  app.post("/inventory/sell", requireUser, async (c) => c.json(await ledger.sellItems(db, c.get("user").id, await body(c))));

  app.get("/fair/seed", requireUser, async (c) => c.json(await ledger.currentSeed(db, c.get("user").id)));
  app.post("/fair/rotate", requireUser, async (c) => c.json(await ledger.rotateSeed(db, c.get("user").id, await body(c))));
  app.get("/fair/seeds/:id", requireUser, async (c) => c.json(await ledger.seedById(db, c.get("user").id, c.req.param("id") ?? "")));

  if (config.devCredit) {
    app.post("/dev/deposit", requireUser, async (c) => c.json(await ledger.creditDeposit(db, c.get("user").id, await body(c))));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.detail }, err.status);
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
