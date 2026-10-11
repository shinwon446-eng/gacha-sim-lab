import { test } from "node:test";
import assert from "node:assert/strict";
import { client, member, ORIGIN, PASSWORD, setup } from "./helpers.js";

test("signup → mailed code → verified session; wrong codes are counted and locked out", async () => {
  const env = await setup();
  const c = client(env.app);
  const email = "Someone@Example.com";
  assert.equal((await c.post("/auth/signup", { email, password: PASSWORD, locale: "ko", acceptedTerms: true })).status, 200);
  const code = env.codes.get("someone@example.com")!;
  assert.match(code, /^\d{6}$/);

  assert.equal((await c.post("/auth/login", { email, password: PASSWORD })).body.error, "email_unverified");
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await c.post("/auth/email/verify", { email, code: wrong })).status, 401);

  const ok = await c.post("/auth/email/verify", { email, code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, "someone@example.com");
  assert.equal(ok.body.user.emailVerified, true);
  assert.equal((await c.get("/auth/session")).body.user.id, ok.body.user.id);
  // a consumed code cannot be reused
  assert.equal((await client(env.app).post("/auth/email/verify", { email, code })).status, 401);
});

test("verification code locks after five wrong attempts", async () => {
  const env = await setup();
  const c = client(env.app);
  await c.post("/auth/signup", { email: "lock@example.com", password: PASSWORD, locale: "en", acceptedTerms: true });
  const code = env.codes.get("lock@example.com")!;
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/auth/email/verify", { email: "lock@example.com", code: wrong })).status, 401);
  assert.equal((await c.post("/auth/email/verify", { email: "lock@example.com", code })).status, 429);
});

test("login, logout and password rules", async () => {
  const env = await setup();
  const m = await member(env, "login@example.com");
  assert.equal((await m.post("/auth/logout", {})).body.loggedOut, true);
  assert.equal((await m.get("/auth/session")).status, 401);

  const c = client(env.app);
  assert.equal((await c.post("/auth/login", { email: "login@example.com", password: "wrong password!!" })).status, 401);
  assert.equal((await c.post("/auth/login", { email: "nobody@example.com", password: PASSWORD })).status, 401);
  assert.equal((await c.post("/auth/login", { email: "login@example.com", password: PASSWORD })).status, 200);
  assert.equal((await c.get("/auth/session")).body.user.email, "login@example.com");
  assert.equal((await c.post("/auth/signup", { email: "short@example.com", password: "short", locale: "ko", acceptedTerms: true })).status, 400);
});

test("signup for an existing verified email does not reveal it or change its password", async () => {
  const env = await setup();
  await member(env, "taken@example.com");
  env.codes.clear();
  const c = client(env.app);
  const r = await c.post("/auth/signup", { email: "taken@example.com", password: "another password 1", locale: "ko", acceptedTerms: true });
  assert.deepEqual(r.body, { verificationRequired: true });
  assert.equal(env.codes.size, 0);
  assert.equal((await c.post("/auth/login", { email: "taken@example.com", password: PASSWORD })).status, 200);
});

test("mutations need the CSRF token and an allowed origin", async () => {
  const env = await setup();
  const m = await member(env);
  const noToken = await m.raw("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 403);
  const badOrigin = await m.raw("/auth/logout", { method: "POST", headers: { Origin: "https://evil.example", "X-CSRF-Token": m.jar.get("voila_csrf")! }, body: "{}" });
  assert.equal(badOrigin.status, 403);
  const preflight = await env.app.request("/open", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("session cookie is HttpOnly and the token is stored only as a hash", async () => {
  const env = await setup();
  const c = client(env.app);
  await c.post("/auth/signup", { email: "cookie@example.com", password: PASSWORD, locale: "ko", acceptedTerms: true });
  const res = await c.raw("/auth/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": c.jar.get("voila_csrf")! },
    body: JSON.stringify({ email: "cookie@example.com", code: env.codes.get("cookie@example.com") }),
  });
  const line = res.headers.getSetCookie().find((l) => l.startsWith("voila_sid="))!;
  assert.match(line, /HttpOnly/);
  const sid = c.jar.get("voila_sid")!;
  const rows = (await env.db.query("SELECT token_hash FROM sessions")).rows as { token_hash: string }[];
  assert.ok(rows.length === 1 && rows[0].token_hash !== sid);
});
