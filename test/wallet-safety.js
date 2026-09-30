#!/usr/bin/env node
/* Wallet-safety gate: two loopholes this file pins down, both found by probing
 * the live routes in the 2026-09-30 sweep.
 *
 * 1. THE SPEND RACE. /api/wallet/order and /api/wallet/bulk-order used to read
 *    check balance -> await supplierPurchaseGuard() -> deduct -> save. The guard
 *    is a network round trip on the live supplier API, so two orders fired
 *    together both passed the check against the same balance and each wrote its
 *    own deduction: more bundles than the customer paid for. The fix puts check,
 *    deduct and save in one synchronous block BEFORE the await, and refunds from
 *    a fresh load when the guard refuses. This gate asserts that order in the
 *    source, because a refactor that quietly re-introduces an await between the
 *    check and the write would not fail any runtime test in mock mode.
 *
 * 2. THE STALE SAVE. bulk-order used to call saveUsers() again AFTER
 *    creditReferralOnFirstPurchase, writing the pre-bonus users array back over
 *    the file and silently swallowing the referral credit. The gate asserts the
 *    last saveUsers in that route comes before the referral credit.
 *
 * Run:  node test/wallet-safety.js
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server", "server.js"), "utf8");
let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failed++; }
};

/* Cut out a route's handler body: from its app.post(...) line to the next
   top-level app. line, so the assertions below never read another route. */
const routeBody = (marker) => {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const next = src.indexOf("\napp.", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
};

const single = routeBody('app.post("/api/wallet/order"');
const bulk = routeBody('app.post("/api/wallet/bulk-order"');
ok(single, "wallet/order route found");
ok(bulk, "wallet/bulk-order route found");

if (single) {
  const check = single.indexOf("if (me.wallet < sell)");
  const deduct = single.indexOf("me.wallet = Math.round((me.wallet - sell)");
  const save = single.indexOf("saveUsers(users);", deduct);
  const guard = single.indexOf("await supplierPurchaseGuard(plan.cost)");
  ok(check !== -1 && deduct !== -1 && save !== -1 && guard !== -1, "check / deduct / save / guard all present");
  ok(deduct > check && guard > save, "wallet/order: deduct+save happen BEFORE the supplier-guard await (spend race closed)");
  const refund = single.indexOf("give the customer their money back");
  ok(refund > guard, "wallet/order: a refused guard refunds from a fresh load");
}

if (bulk) {
  const check = bulk.indexOf("if (me.wallet < total)");
  const deduct = bulk.indexOf("me.wallet = Math.round((me.wallet - total)");
  const guard = bulk.indexOf("await supplierPurchaseGuard(supplierTotal)");
  ok(check !== -1 && deduct !== -1 && guard !== -1, "bulk: check / deduct / guard all present");
  ok(deduct > check && guard > deduct, "bulk: deduct+save happen BEFORE the supplier-guard await (spend race closed)");
  const lastSave = bulk.lastIndexOf("saveUsers(users);");
  const credit = bulk.indexOf("creditReferralOnFirstPurchase(me.id)");
  ok(lastSave !== -1 && credit > lastSave, "bulk: no saveUsers after the referral credit (stale-save clobber closed)");
}

/* The data files must be 0600: they hold PII, password hashes and bearer tokens. */
const store = fs.readFileSync(path.join(__dirname, "..", "server", "lib", "store.js"), "utf8");
ok(/writeFileSync\(tmp,[^\n]*mode:\s*0o600/.test(store), "store.js saveJson writes 0600");

console.log(failed ? `\n===== ${failed} failed =====` : "\n===== wallet-safety: all gates pass =====");
process.exit(failed ? 1 : 0);
