#!/usr/bin/env node
/* Gate for the number-lockout denial of service.

   THE ATTACK, as it worked on 2026-09-30:
   1. An attacker posts a guest MANUAL order for a victim's phone number. Manual
      means no payment is taken and nothing is sent to the supplier - it is free.
   2. recentOrderForNumber() treated "pending" as an open order, so that unpaid
      order blocked the victim's own purchase for 30 minutes with a 409.
   3. The attacker repeats every 30 minutes, indefinitely. The 24-hour unpaid
      expiry never helps, because each new order replaces the last one.
   Net effect: any phone number could be taken out of the shop for free, forever.

   THE RULE: an unpaid order was never sent to iDATA, so it cannot cause the
   supplier rejection this check exists to prevent. Only a PAID order (or one whose
   payment has been taken) may hold a number. That makes the attack cost real
   money, at which point blocking is legitimate because iDATA really would reject
   a second order for the same number.

   Run: node test/number-lockout-safety.js
*/

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pdh-lockout-"));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};

// Load the real predicate out of the module under test, rather than re-typing it,
// so this gate cannot pass while the shipped code does something else.
const src = fs.readFileSync(path.join(__dirname, "..", "server", "lib", "orders.js"), "utf8");

/* Slice a named `function name(...) { ... }` out of the module by brace matching,
   so the gate exercises the shipped source rather than a copy of it. */
const grab = (name) => {
  const i = src.indexOf(`function ${name}`);
  if (i === -1) throw new Error(`${name} not found in lib/orders.js`);
  let d = 0, k = src.indexOf("{", i);
  const start = k;
  while (k < src.length) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) { k++; break; } }
    k++;
  }
  if (d !== 0) throw new Error(`${name} braces did not balance`);
  return src.slice(i, k);
};
/* `const NAME = [...]` up to the semicolon. */
const grabConst = (name) => {
  const i = src.indexOf(`const ${name}`);
  if (i === -1) throw new Error(`${name} not found`);
  return src.slice(i, src.indexOf(";", i) + 1).replace("const", "var");
};

/* Built with Function(), not eval, so the declarations live in their own scope and
   cannot collide with anything here. OPEN_STATUSES is declared first because
   PAID_OPEN_STATUSES spreads it, and orderBlocksNumber closes over both. */
const orderBlocksNumber = new Function(
  grabConst("OPEN_STATUSES") + grabConst("PAID_OPEN_STATUSES") +
  `return (${grab("orderBlocksNumber")});`
)();

const now = Date.now();
const order = (over) => Object.assign({
  id: "X", status: "pending", phone: "0240000000",
  created: new Date(now - 60 * 1000).toISOString(),
}, over);

console.log("  --- the attack: an UNPAID order must not hold the number ---");
ok("a guest MANUAL order (pending, unpaid) does NOT block",
  orderBlocksNumber(order({ status: "pending" })) === false);
ok("  even when brand new",
  orderBlocksNumber(order({ status: "pending", created: new Date().toISOString() })) === false);
ok("  and even with no paystackRef at all",
  orderBlocksNumber(order({ status: "pending", paystackRef: undefined, verifiedAt: undefined })) === false);

console.log("  --- a real payment MUST still block, or the supplier rule is gone ---");
ok("a paid order blocks",
  orderBlocksNumber(order({ status: "paid" })) === true);
ok("a processing order blocks (the supplier may already have it)",
  orderBlocksNumber(order({ status: "processing" })) === true);
ok("a pending_payment card order blocks",
  orderBlocksNumber(order({ status: "pending_payment" })) === true);
ok("a pending order that HAS a paystackRef blocks (money was taken)",
  orderBlocksNumber(order({ status: "pending", paystackRef: "ps_abc" })) === true);
ok("a pending order that is verified blocks",
  orderBlocksNumber(order({ status: "pending", verifiedAt: new Date().toISOString() })) === true);

console.log("  --- the attacker's renewal loop is now worthless ---");
// The attacker refreshes every 30 minutes. Simulate 24 hours of that.
let everBlocked = false;
for (let m = 0; m <= 1440; m += 30) {
  const attackerOrder = order({
    status: "pending",
    created: new Date(now - m * 60 * 1000).toISOString(),
  });
  if (orderBlocksNumber(attackerOrder)) everBlocked = true;
}
ok("24 hours of unpaid renewals never blocks the victim", everBlocked === false);

console.log("  --- but a customer who actually paid is still protected ---");
const paidThen = order({ status: "paid", created: new Date(now - 5 * 60 * 1000).toISOString() });
ok("a paid order from 5 minutes ago blocks a second order",
  orderBlocksNumber(paidThen) === true);

console.log("  --- the shipped module must actually use the predicate ---");
ok("recentOrderForNumber filters on orderBlocksNumber",
  /\.filter\(\(o\) => o\.phone === digits && orderBlocksNumber\(o\)\)/.test(src));
ok("recentOrderForNumber no longer filters on the raw OPEN_STATUSES list",
  !/o\.phone === digits && OPEN_STATUSES\.includes/.test(src));
ok("orderBlocksNumber is exported for reuse",
  /module\.exports\s*=\s*\{[^}]*orderBlocksNumber/.test(src));

console.log(`\n  ===== ${pass} passed, ${fail} failed =====`);
if (fail) {
  console.log("  A failure here means any phone number can be locked out of the shop for free.");
}
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
