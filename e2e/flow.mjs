/**
 * End-to-end flow against a running server with an EMPTY database:
 *   DATA_DIR=/tmp/hearth-e2e APP_SECRET=... DISABLE_JOBS=1 npx next start -p 3200 &
 *   BASE=http://localhost:3200 node e2e/flow.mjs [screenshotDir]
 * Covers: first-run setup, TOTP enrollment + 2FA login, partner invite, manual
 * account, CSV import with column mapping, categorization, rule creation,
 * shared expense + settle-up, budget plan, and the monthly close.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";

// CommonJS require so a globally installed Playwright (or the project one) resolves.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE ?? "http://localhost:3200";
const SHOTS = process.argv[2];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totp(secret, t = Date.now()) {
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret.replace(/\s/g, "")) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}

const settle = (pg) => pg.waitForLoadState("networkidle");
const step = (name) => console.log(`✓ ${name}`);
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const today = new Date();
const ym = (d) => d.toISOString().slice(0, 7);
const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 10));
const p2 = (n) => String(n).padStart(2, "0");
const mdy = (d) => `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));

  // 1. Setup
  await p.goto(`${BASE}/`);
  await settle(p);
  await p.waitForURL(/\/setup/);
  await p.fill("input[name=household]", "Test Household");
  await p.fill("input[name=name]", "Matt");
  await p.fill("input[name=partner]", "Jess");
  await p.fill("input[name=email]", "matt@example.test");
  await p.fill("input[name=password]", "correct horse battery");
  await Promise.all([p.waitForURL(/settings\/security/), p.click("button[type=submit]")]);
  step("first-run setup");

  // 2. TOTP
  await p.waitForLoadState("networkidle");
  await p.click("button:has-text('Set up two-factor')");
  const secret = (await p.locator("code").innerText()).replace(/\s/g, "");
  assert.match(secret, /^[A-Z2-7]{32}$/);
  await p.waitForLoadState("networkidle");
  await p.fill("input[name=code]", totp(secret));
  await p.click("button:has-text('Turn on')");
  await p.waitForSelector("text=Two-factor authentication is on", { timeout: 8000 }).catch(async (e) => {
    console.log("DEBUG:", (await p.locator("main").innerText()).slice(0, 700));
    throw e;
  });
  step("TOTP enrollment");
  await p.goto(`${BASE}/`);
  await settle(p);
  await p.click("text=Sign out");
  await p.waitForURL(/login/);
  await p.fill("input[name=email]", "matt@example.test");
  await p.fill("input[name=password]", "correct horse battery");
  await Promise.all([p.waitForURL(/login\/2fa/), p.click("button[type=submit]")]);
  await p.fill("input[name=code]", "000000");
  await p.click("button[type=submit]");
  await p.waitForSelector("text=That code didn't work");
  await p.fill("input[name=code]", totp(secret));
  await Promise.all([p.waitForURL(`${BASE}/`), p.click("button[type=submit]")]);
  step("2FA login (rejects bad code, accepts good code)");

  // 3. Invite partner
  await p.goto(`${BASE}/settings/household`);
  await settle(p);
  await p.click("text=Create invite link");
  const link = await p.locator("input[readonly]").inputValue();
  assert.match(link, /\/invite\//);
  const ctx2 = await browser.newContext();
  const q = await ctx2.newPage();
  await q.goto(link);
  await settle(q);
  await q.fill("input[name=name]", "Jess");
  await q.fill("input[name=email]", "jess@example.test");
  await q.fill("input[name=password]", "another long passphrase");
  await Promise.all([q.waitForURL(/settings\/security/), q.click("button[type=submit]")]);
  const reuse = await (await browser.newContext()).newPage();
  await reuse.goto(link);
  await settle(reuse);
  await reuse.fill("input[name=name]", "X");
  await reuse.fill("input[name=email]", "x@example.test");
  await reuse.fill("input[name=password]", "another long passphrase");
  await reuse.click("button[type=submit]");
  await reuse.waitForSelector("text=invalid or expired");
  step("partner invite accepted; invite cannot be reused");

  // 4. Manual accounts
  for (const [name, type, owner, bal] of [["Matt Checking", "checking", "A", "2500"], ["Jess Checking", "checking", "B", "1800"]]) {
    await p.goto(`${BASE}/accounts/new`);
    await settle(p);
    await p.fill("input[name=name]", name);
    await p.selectOption("select[name=type]", type);
    await p.selectOption("select[name=owner]", owner);
    await p.fill("input[name=balance]", bal);
    await Promise.all([p.waitForURL(/accounts\/.+saved=1/), p.click("text=Add account")]);
  }
  step("manual accounts");

  // 5. CSV import
  const csv = [
    "Posted Date,Payee,Amount",
    `${mdy(prev)},WHOLEFDS MKT 10234,-120.00`,
    `${mdy(new Date(prev.getTime() + 86400000))},ACME CORP PAYROLL,3000.00`,
    `${mdy(new Date(prev.getTime() + 2 * 86400000))},SQ *BLUE BOTTLE COFFEE,-6.50`,
    `${mdy(new Date(prev.getTime() + 3 * 86400000))},LOCAL HARDWARE CO,-42.10`,
  ].join("\n");
  fs.writeFileSync("/tmp/hearth-e2e.csv", csv);
  await p.goto(`${BASE}/import`);
  await settle(p);
  await p.selectOption("select[name=accountId]", { label: "Matt Checking" });
  await p.setInputFiles("input[type=file]", "/tmp/hearth-e2e.csv");
  await p.waitForSelector("text=Map columns");
  assert.equal(await p.locator("select[name=colDate]").inputValue(), "Posted Date");
  assert.equal(await p.locator("select[name=colAmount]").inputValue(), "Amount");
  await p.click("button:has-text('Import')");
  await p.waitForSelector("text=Imported 4 new transactions");
  await p.setInputFiles("input[type=file]", "/tmp/hearth-e2e.csv");
  await p.waitForSelector("text=Map columns");
  await p.click("button:has-text('Import')");
  await p.waitForSelector("text=Imported 0 new transactions");
  step("CSV import with auto-mapped columns; re-import is a no-op");

  // 6. Categorize and rule
  await p.goto(`${BASE}/transactions?month=${ym(prev)}`);
  await settle(p);
  await shot(p, "transactions");
  const row = p.locator("li", { hasText: "Local Hardware" });
  await row.locator("select[name=categoryId]").selectOption({ label: "Household supplies" });
  await p.waitForTimeout(800);
  await p.reload();
  assert.equal(await p.locator("li", { hasText: "Local Hardware" }).locator("select[name=categoryId] option:checked").innerText(), "Household supplies");
  const payroll = p.locator("li", { hasText: "Acme Corp Payroll" });
  assert.equal(await payroll.locator("select[name=categoryId] option:checked").innerText(), "Paychecks");
  step("inline categorization persists; starter rule categorized payroll");

  await p.click("a:has-text('Wholefds'), a:has-text('Whole Foods')");
  await p.check("input[name=isShared]");
  await p.click("button:has-text('Save')");
  await p.waitForSelector("text=Saved.");
  step("marked a transaction as a shared expense");

  // 7. Couple settle-up reflects it (income split falls back to 50/50 without income data)
  await p.goto(`${BASE}/couple`);
  await settle(p);
  await p.waitForSelector("text=Jess owes Matt");
  await shot(p, "couple");
  step("settle-up shows partner owes their share");

  // 8. Budget plan
  await p.goto(`${BASE}/budget?month=${ym(today)}`);
  await settle(p);
  await p.fill("input[name=expectedIncome]", "6000");
  await p.fill("input[name=savingsGoals]", "500");
  await p.click("button:has-text('Save plan')");
  await p.waitForSelector("text=Plan saved.");
  await shot(p, "budget");
  step("budget plan saved");

  // 9. Close last month and verify the lock
  await p.goto(`${BASE}/close?month=${ym(prev)}`);
  await settle(p);
  await p.click(`button:has-text('Close ${ym(prev)}')`);
  await p.waitForSelector("text=Closed on");
  await p.goto(`${BASE}/transactions?month=${ym(prev)}`);
  await settle(p);
  await p.click("a:has-text('Local Hardware')");
  await p.waitForSelector(`text=${ym(prev)} is closed`);
  await p.fill("textarea[name=notes]", "edit after close");
  await p.click("button:has-text('Save')");
  await p.waitForSelector("text=is closed. Reopen it");
  step("month close locks edits");

  // 10. Exports
  const res = await p.request.get(`${BASE}/api/export?format=csv`);
  assert.equal(res.status(), 200);
  const body = await res.text();
  assert.match(body, /Household supplies/);
  const anon = await (await browser.newContext()).request.get(`${BASE}/api/export?format=json`);
  assert.equal(anon.status(), 401);
  step("CSV export works; export requires auth");

  // 11. Mobile layout sanity
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${BASE}/`);
  await settle(p);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, "horizontal overflow on mobile dashboard");
  await shot(p, "mobile-dashboard");
  step("mobile dashboard has no horizontal scroll");

  assert.deepEqual(errors, [], "browser errors");
  console.log("\nALL E2E CHECKS PASSED");
} finally {
  await browser.close();
}
