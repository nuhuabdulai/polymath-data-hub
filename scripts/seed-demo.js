#!/usr/bin/env node
/* Rebuild data/*.json into a small, coherent, QUIET demo dataset.
 *
 *   ALLOW_DEMO_SEED=1 node scripts/seed-demo.js
 *
 * The guard is deliberate: on the live server this file must never run, because
 * it replaces the orders file — the one that moves money. It only runs when
 * ALLOW_DEMO_SEED=1 is set, and it backs the current data up first.
 *
 * Quiet by construction: server/lib/orders.js watches every paid / processing /
 * pending_payment order that has no supplier reference and raises a "NEVER
 * sent" alert after 4 minutes, and every processing order older than 3 hours.
 * So this dataset gives every paid order a providerRef, keeps its one
 * processing order younger than the window, uses "pending" (unpaid, manual
 * MoMo) for the awaiting-payment rows, and leaves alerts empty. A freshly
 * seeded demo raises no alerts and stays quiet while you look at it.
 *
 * Prices, plan ids and bundle names all come from the real catalogue
 * (lib/idatagh.js mockProducts + lib/pricing.js markups), so the demo orders
 * can never disagree with what the storefront sells.
 */

const fs = require("fs");
const path = require("path");

if (process.env.ALLOW_DEMO_SEED !== "1") {
  console.error("Refusing to run: this overwrites data/*.json.");
  console.error("If you are sure (sandbox/demo only), run:  ALLOW_DEMO_SEED=1 node scripts/seed-demo.js");
  process.exit(1);
}

const { mockProducts } = require("../server/lib/idatagh.js");
const { loadPricing } = require("../server/lib/pricing.js");

const DATA = path.join(__dirname, "..", "data");
const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

// ---- catalogue-driven pricing (same arithmetic as the storefront) ----------
const pricing = loadPricing();
const memberSell = (cost) => round2(cost * (1 + Number(pricing.markupPercent) / 100));
const guestSell = (cost) => round2(cost * (1 + Number(pricing.guestMarkupPercent) / 100));
const plan = (id) => {
  const p = mockProducts().find((x) => x.id === id);
  if (!p) throw new Error(`catalogue has no plan ${id}`);
  return { planId: String(p.id), planName: p.name, network: p.network, cost: p.cost };
};

// ---- deterministic-looking refs (fixed, so re-seeding is reproducible) -----
const hex = (s) => s; // kept explicit at each call site
const track = (s) => `PD-${s}`;

// ---- orders ---------------------------------------------------------------
// status coverage: delivered x3, paid (sent), processing (sent, fresh),
// pending x2 (unpaid manual MoMo), cancelled (refund owed), refunded, failed.
const O = (id, p, sell, extra) => ({
  id,
  trackCode: track(extra._track),
  created: ago(extra._created),
  status: extra.status,
  planName: p.planName,
  planId: p.planId,
  network: p.network,
  phone: extra.phone,
  name: extra.name ?? null,
  email: extra.email ?? null,
  cost: p.cost,
  sell,
  currency: "GHS",
  reference: extra._ref,
  source: extra.source,
  userId: extra.userId ?? null,
  paystackRef: extra.source === "card" ? `ps_demo_${id.slice(2)}` : null,
  verifiedAt: extra.verified != null ? ago(extra.verified) : undefined,
  sendAttempts: extra.sendAttempts ?? 0,
  providerRef: extra.providerRef ?? null,
  ...extra.fields,
});
const strip = (o) => JSON.parse(JSON.stringify(o)); // drop undefined fields

const orders = [
  strip(O("YB0001", plan(2), memberSell(7.5), {
    status: "delivered", phone: "0241110001", name: "Ama Demo", email: "ama@example.com",
    source: "wallet", userId: "U1001", _created: 1560, _ref: "a1b2c3d4e5f6", _track: "10F71961BD",
    fields: { sendAttempts: 1, providerRef: "IDATA-88110", providerStatus: "delivered",
      providerMessage: "Delivered successfully", deliveredAt: ago(1554), autoSendTriedAt: ago(1559) },
  })),
  strip(O("YB0002", plan(12), memberSell(13.5), {
    status: "delivered", phone: "0201110002", name: "Kofi Demo", email: "kofi@example.com",
    source: "wallet", userId: "U1002", _created: 1500, _ref: "b2c3d4e5f6a7", _track: "DB61277694",
    fields: { sendAttempts: 1, providerRef: "IDATA-88111", providerStatus: "delivered",
      providerMessage: "Delivered successfully", deliveredAt: ago(1494), autoSendTriedAt: ago(1499) },
  })),
  strip(O("YB0003", plan(7), guestSell(7), {
    status: "delivered", phone: "0271110003", source: "card", _created: 180, _ref: "c3d4e5f6a7b8", _track: "94FAB99D6C",
    verified: 179, fields: { sendAttempts: 1, providerRef: "IDATA-88115", providerStatus: "delivered",
      providerMessage: "Delivered successfully", deliveredAt: ago(174), autoSendTriedAt: ago(179) },
  })),
  strip(O("YB0004", plan(4), memberSell(30), {
    status: "paid", phone: "0241110001", name: "Ama Demo", email: "ama@example.com",
    source: "card", userId: "U1001", _created: 35, _ref: "d4e5f6a7b8c9", _track: "3FB55A726B",
    verified: 34, sendAttempts: 1, providerRef: "IDATA-88472",
    fields: { providerStatus: "processing", providerMessage: "Order received by supplier", autoSendTriedAt: ago(34) },
  })),
  strip(O("YB0005", plan(5), guestSell(55), {
    status: "processing", phone: "0201110005", source: "card", _created: 50, _ref: "e5f6a7b8c9d0", _track: "E894C3E658",
    verified: 49, sendAttempts: 1, providerRef: "IDATA-88473",
    fields: { providerStatus: "processing", providerMessage: "Order received by supplier", autoSendTriedAt: ago(49) },
  })),
  strip(O("YB0006", plan(3), guestSell(13.5), {
    status: "pending", phone: "0241110006", name: "Guest Buyer", source: "manual",
    _created: 20, _ref: "f6a7b8c9d0e1", _track: "676C111242", fields: {},
  })),
  strip(O("YB0007", plan(8), guestSell(13), {
    status: "pending", phone: "0271110007", source: "manual", _created: 8, _ref: "a7b8c9d0e1f2", _track: "CC8895F547",
    fields: {},
  })),
  strip(O("YB0008", plan(5), guestSell(55), {
    status: "cancelled", phone: "0241110008", source: "card", _created: 1810, _ref: "b8c9d0e1f2a3", _track: "1F0BB119FC",
    verified: 1809,
    fields: { cancelledAt: ago(1800), refundOwed: true,
      cancelReason: "cancelled by admin: payment was taken and no data was ever sent to the supplier (refund owed to customer)" },
  })),
  strip(O("YB0009", plan(6), memberSell(100), {
    status: "refunded", phone: "0241110001", name: "Ama Demo", email: "ama@example.com",
    source: "card", userId: "U1001", _created: 1680, _ref: "c9d0e1f2a3b4", _track: "D3ADB33F01",
    verified: 1679, sendAttempts: 1, providerRef: "IDATA-88140",
    fields: { providerStatus: "failed", providerMessage: "The supplier could not deliver to this number.",
      refundStatus: "refunded", refundMethod: "paystack", refundRef: "RFN-DEMO-1",
      refundedAt: ago(1620), refundOwed: false },
  })),
  strip(O("YB0010", plan(9), guestSell(29), {
    status: "failed", phone: "0271110010", name: "Yaa Demo", source: "card",
    _created: 300, _ref: "d0e1f2a3b4c5", _track: "AB44C1E2F9",
    verified: 299, sendAttempts: 1,
    fields: { providerRef: null, sendFailedAt: ago(299), providerStatus: "not-sent",
      providerMessage: "The supplier did not accept this order.", error: "iDATA 502: upstream timeout",
      autoSendTriedAt: ago(299) },
  })),
];

// ---- users (wallets reconcile with the wallet orders and top-ups below) ----
const users = [
  { id: "U1001", name: "Ama Demo", phone: "0241110001", email: "ama@example.com",
    wallet: round2(50 - 7.5), created: ago(3140), passHash: null, salt: null, googleId: "demo-google-1" },
  { id: "U1002", name: "Kofi Demo", phone: "0201110002", email: "kofi@example.com",
    wallet: round2(20 - 13.5), created: ago(2740), passHash: null, salt: null, googleId: "demo-google-2" },
];

// ---- top-ups: two credited (matching the wallets above), one pending -------
const topups = [
  { id: "TPDEMO1", userId: "U1001", name: "Ama Demo", phone: "0241110001", amount: 50,
    status: "paid", method: "paystack", created: ago(1565), handledAt: ago(1564),
    paystackRef: "TPDEMO1", credited: true, walletAfter: 50 },
  { id: "TPDEMO2", userId: "U1002", name: "Kofi Demo", phone: "0201110002", amount: 20,
    status: "paid", method: "paystack", created: ago(1505), handledAt: ago(1504),
    paystackRef: "TPDEMO2", credited: true, walletAfter: 20 },
  { id: "TPDEMO3", userId: "U1002", name: "Kofi Demo", phone: "0201110002", amount: 20,
    status: "pending", method: "manual", note: "Paid to MoMo, checking", created: ago(120), handledAt: null },
];

// ---- activity, alerts, switches -------------------------------------------
const activity = [
  { t: ago(8), type: "order", msg: "New order YB0007 (AirtelTigo 2GB (30 days)) placed manually — waiting for MoMo payment." },
  { t: ago(20), type: "order", msg: "New order YB0006 (MTN 2GB (30 days)) placed manually — waiting for MoMo payment." },
  { t: ago(49), type: "order", msg: "Order YB0005 paid via Paystack (ps_demo_0005) and sent to the supplier (IDATA-88473)." },
  { t: ago(34), type: "order", msg: "Order YB0004 paid via Paystack (ps_demo_0004) and sent to the supplier (IDATA-88472)." },
  { t: ago(174), type: "order", msg: "Order YB0003 (AirtelTigo 1GB (30 days)) delivered (IDATA-88115)." },
  { t: ago(300), type: "order", msg: "Order YB0010 failed to send: iDATA 502: upstream timeout." },
  { t: ago(1620), type: "order", msg: "Order YB0009 refunded to card (RFN-DEMO-1) after the supplier could not deliver." },
  { t: ago(1504), type: "topup", msg: "Wallet top-up of GHS 20.00 by Kofi Demo confirmed via Paystack and credited." },
  { t: ago(1564), type: "topup", msg: "Wallet top-up of GHS 50.00 by Ama Demo confirmed via Paystack and credited." },
  { t: ago(1800), type: "order", msg: "Order YB0008 cancelled by admin — payment taken, nothing sent; refund owed to the customer." },
];

const alerts = [];
const autoapprove = { on: false, updatedAt: ago(2900), updatedBy: "owner" };

// ---- self-check: refuse to write anything if the money is not finite ------
for (const o of orders) {
  if (!(Number.isFinite(o.sell) && o.sell > 0)) throw new Error(`order ${o.id} got a non-finite sell — pricing keys changed?`);
  if (!(Number.isFinite(o.cost) && o.cost > 0)) throw new Error(`order ${o.id} got a non-finite cost`);
}
// wallets must reconcile with the wallet orders and credited top-ups
const credited = (id) => topups.filter((t) => t.userId === id && t.credited).reduce((a, t) => a + t.amount, 0);
const spent = (id) => orders.filter((o) => o.userId === id && o.source === "wallet").reduce((a, o) => a + o.cost, 0);
for (const u of users) {
  if (round2(credited(u.id) - spent(u.id)) !== u.wallet) {
    throw new Error(`user ${u.id} wallet ${u.wallet} does not reconcile: credited ${credited(u.id)} - wallet orders ${spent(u.id)}`);
  }
}

// ---- write (same tmp+rename pattern as server/lib/store.js) ---------------
const write = (name, value) => {
  const f = path.join(DATA, name);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, f);
};

// ---- backup whatever is there now -----------------------------------------
const backupDir = path.join(DATA, `demo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const f of fs.readdirSync(DATA)) {
  if (f.endsWith(".json")) fs.copyFileSync(path.join(DATA, f), path.join(backupDir, f));
}

write("orders.json", orders);
write("users.json", users);
write("topups.json", topups);
write("activity.json", activity);
write("alerts.json", alerts);
write("autoapprove.json", autoapprove);

console.log(`Seeded demo data (previous files backed up to ${path.relative(process.cwd(), backupDir)}):`);
console.log(`  orders      ${orders.length}  (delivered 3, paid 1, processing 1, pending 2, cancelled 1, refunded 1, failed 1)`);
console.log(`  users       ${users.length}  (wallets ${users.map((u) => `${u.id} GHS ${u.wallet.toFixed(2)}`).join(", ")})`);
console.log(`  topups      ${topups.length}  (2 credited, 1 pending)`);
console.log(`  activity    ${activity.length} entries, alerts empty, autoapprove off`);
console.log("  quiet by construction: every paid order carries a providerRef; the one processing order is inside the 3h window.");
