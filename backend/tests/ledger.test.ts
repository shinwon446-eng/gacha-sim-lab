import { test } from "node:test";
import assert from "node:assert/strict";
import { getBoxBySlug, dropTable } from "../../web/lib/products";
import { verifyRoll } from "../../web/lib/fairness";
import { ledgerMatches, member, rid, setup } from "./helpers.js";

test("wallet starts at zero and needs a session", async () => {
  const env = await setup();
  const m = await member(env);
  const w = (await m.get("/wallet")).body;
  assert.equal(w.balance, 0);
  assert.deepEqual(w.transactions, []);
  const anon = await env.app.request("/wallet");
  assert.equal(anon.status, 401);
});

test("insufficient balance charges nothing and reports the shortfall", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 2, requestId: rid() });
  const r = await m.post("/open", { boxSlug: "starter-ps5", quantity: 1, requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "insufficient_balance");
  assert.equal(r.body.shortfallUsdt, 1);
  const w = (await m.get("/wallet")).body;
  assert.equal(w.balance, 2);
  assert.equal((await m.get("/inventory")).body.items.length, 0);
  assert.ok(await ledgerMatches(env.db, m.userId));
});

test("opening debits, draws, stores items and settles cash in one transaction", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 50, requestId: rid() });
  const r = await m.post("/open", { boxSlug: "dollar-apple", quantity: 20, requestId: rid() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results.length, 20);
  assert.equal(r.body.costUsdt, 20);
  assert.equal(r.body.fair.serverSeedHash.length, 64);
  assert.equal(JSON.stringify(r.body).includes("serverSeed\""), false, "active server seed must not leak");

  const cash = r.body.results.filter((x: any) => x.settled).reduce((s: number, x: any) => s + Math.round(x.valueUsdt * 100), 0);
  assert.equal(Math.round(r.body.wallet.balance * 100), 5000 - 2000 + cash);
  // dollar boxes are not low risk: full rollover credit
  assert.equal(r.body.wallet.totalWagered, 20);

  const inv = (await m.get("/inventory")).body.items;
  assert.equal(inv.length, 20);
  assert.equal(inv.filter((i: any) => i.status === "IN_STORAGE").length, r.body.results.filter((x: any) => !x.settled).length);
  assert.ok(await ledgerMatches(env.db, m.userId));
});

test("a repeated requestId returns the same order and never charges twice", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 10, requestId: rid() });
  const requestId = rid();
  const first = await m.post("/open", { boxSlug: "dollar-apple", quantity: 3, requestId });
  const again = await m.post("/open", { boxSlug: "dollar-apple", quantity: 3, requestId });
  assert.deepEqual(again.body, first.body);
  assert.equal((await m.get("/inventory")).body.items.length, 3);
  const reused = await m.post("/open", { boxSlug: "dollar-apple", quantity: 4, requestId });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_id_reused");
  assert.ok(await ledgerMatches(env.db, m.userId));
});

test("concurrent openings cannot overdraw the balance", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 5, requestId: rid() });
  const attempts = await Promise.all(Array.from({ length: 12 }, () => m.post("/open", { boxSlug: "dollar-apple", quantity: 1, requestId: rid() })));
  const ok = attempts.filter((a) => a.status === 200);
  assert.ok(ok.length >= 5, `at least the funded five succeed, got ${ok.length}`);
  for (const a of attempts.filter((a) => a.status !== 200)) assert.equal(a.body.error, "insufficient_balance");
  const w = (await m.get("/wallet")).body;
  assert.ok(w.balance >= 0);
  const nonces = (await m.get("/inventory")).body.items.map((i: any) => i.fair.nonce).sort((a: number, b: number) => a - b);
  assert.deepEqual(nonces, nonces.map((_: number, i: number) => i), "every opening gets a unique consecutive nonce");
  assert.ok(await ledgerMatches(env.db, m.userId));
});

test("sellback pays 95% once, back to the paying bucket", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 30, requestId: rid() });
  await m.post("/open", { boxSlug: "dollar-apple", quantity: 30, requestId: rid() });
  const stored = (await m.get("/inventory")).body.items.filter((i: any) => i.status === "IN_STORAGE");
  if (stored.length === 0) return; // every draw was cash; nothing to sell
  const before = (await m.get("/wallet")).body;
  const ids = stored.map((i: any) => i.id);
  const expected = stored.reduce((s: number, i: any) => s + Math.round(i.valueUsdt * 0.95 * 100), 0);
  const sold = await m.post("/inventory/sell", { ids, requestId: rid() });
  assert.equal(sold.status, 200);
  assert.equal(Math.round(sold.body.totalUsdt * 100), expected);
  assert.equal(sold.body.toCard, 0, "crypto-funded items pay back to crypto only");
  assert.equal(Math.round(sold.body.wallet.cryptoBalance * 100), Math.round(before.cryptoBalance * 100) + expected);
  const twice = await m.post("/inventory/sell", { ids, requestId: rid() });
  assert.equal(twice.status, 409);
  assert.ok(await ledgerMatches(env.db, m.userId));
});

test("another account cannot sell or see my items", async () => {
  const env = await setup();
  const a = await member(env);
  const b = await member(env);
  await a.post("/dev/deposit", { network: "TRC20", amountUsdt: 30, requestId: rid() });
  await a.post("/open", { boxSlug: "dollar-apple", quantity: 30, requestId: rid() });
  const mine = (await a.get("/inventory")).body.items.filter((i: any) => i.status === "IN_STORAGE");
  assert.equal((await b.get("/inventory")).body.items.length, 0);
  if (mine.length) assert.equal((await b.post("/inventory/sell", { ids: [mine[0].id], requestId: rid() })).status, 404);
});

test("revealed seed reproduces every recorded draw with the public verifier", async () => {
  const env = await setup();
  const m = await member(env);
  await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 10, requestId: rid() });
  const opened = await m.post("/open", { boxSlug: "dollar-galaxy", quantity: 5, requestId: rid() });
  const committed = opened.body.fair;

  const hidden = await m.get(`/fair/seeds/${committed.seedId}`);
  assert.equal(hidden.body.retired, false);
  assert.equal("serverSeed" in hidden.body, false);

  const rotated = await m.post("/fair/rotate", { clientSeed: "my-own-seed" });
  assert.equal(rotated.body.revealed.seedId, committed.seedId);
  assert.equal(rotated.body.current.clientSeed, "my-own-seed");
  assert.equal(rotated.body.current.nextNonce, 0);

  const box = getBoxBySlug("dollar-galaxy")!;
  for (const r of opened.body.results) {
    const v = await verifyRoll({ serverSeed: rotated.body.revealed.serverSeed, serverSeedHash: committed.serverSeedHash, clientSeed: committed.clientSeed, nonce: r.nonce, items: dropTable(box) });
    assert.equal(v.hashMatches, true);
    assert.equal(v.roll, r.roll);
    assert.equal(v.item.id, r.itemId);
  }
});

test("dev credit route does not exist unless enabled", async () => {
  const env = await setup({ devCredit: false });
  const m = await member(env);
  assert.equal((await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 10, requestId: rid() })).status, 404);
});

test("input validation", async () => {
  const env = await setup();
  const m = await member(env);
  assert.equal((await m.post("/open", { boxSlug: "nope", quantity: 1, requestId: rid() })).status, 400);
  assert.equal((await m.post("/open", { boxSlug: "dollar-apple", quantity: 101, requestId: rid() })).status, 400);
  assert.equal((await m.post("/open", { boxSlug: "dollar-apple", quantity: 1.5, requestId: rid() })).status, 400);
  assert.equal((await m.post("/open", { boxSlug: "dollar-apple", quantity: 1 })).status, 400);
  assert.equal((await m.post("/dev/deposit", { network: "TRC20", amountUsdt: 1.005, requestId: rid() })).status, 400);
  assert.equal((await m.post("/inventory/sell", { ids: ["x"], requestId: rid() })).status, 400);
});
