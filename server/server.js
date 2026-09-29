/* Point dotenv at THIS FILE's directory, not at process.cwd().

   It used to be a bare `require("dotenv").config()`, which resolves .env against
   the directory the process was started from. The documented setup in the README
   is `node server/server.js` from the repository root, so every setting in
   server/.env was silently ignored. The independent review of 2026-09-29 measured
   ADMIN_USER as "owner" when started from server/ and undefined when started from
   the root.

   That was not just a login inconvenience: with no environment loaded, mock mode
   defaulted ON (see mockEnabled in lib/idatagh.js) and the storefront reported
   "Delivered successfully" for money it had not delivered. Fixing the path AND
   inverting the mock default are both required - either alone still leaves a
   storefront that can lie. */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const idatagh = require("./lib/idatagh");

/* Mock mode is decided in ONE place, the supplier adapter, so the API, the health
   endpoint, the admin banner and the supplier calls can never disagree about
   whether this storefront is talking to a real supplier. */
const mockEnabled = () => idatagh.mockEnabled();
const paystack = require("./lib/paystack");

const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

const cfg = (k, f = "") => {
  const v = process.env[k];
  return v === undefined || v === "" ? f : v;
};
const PORT = Number(cfg("PORT", "4000"));
const DEFAULT_MARKUP = Number(cfg("MARKUP_PERCENT", "15"));
const DEFAULT_GUEST_MARKUP = Number(cfg("GUEST_MARKUP_PERCENT", "55"));
const CURRENCY = cfg("CURRENCY", "GHS");
let ADMIN_USER = cfg("ADMIN_USER");
let ADMIN_PASS = cfg("ADMIN_PASS");
const PUBLIC_BASE = cfg("PUBLIC_BASE_URL", "");
const SITE_NAME = cfg("SITE_NAME", "POLYMATH DATA HUB");
const DATA_FILE = path.join(__dirname, "..", "data", "orders.json");
const PRICING_FILE = path.join(__dirname, "..", "data", "pricing.json");
const MAINTENANCE_FILE = path.join(__dirname, "..", "data", "maintenance.json");
const MAINTENANCE_HTML = path.join(__dirname, "..", "public", "maintenance.html");

function maintenanceState() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, "utf8") || "{}");
    if (raw && raw.on !== undefined && typeof raw.on !== "boolean") return { on: true, updatedAt: null, updatedBy: null, error: "maintenance state is invalid" };
    return { on: raw && raw.on === true, updatedAt: raw && (raw.updatedAt || null), updatedBy: raw && (raw.updatedBy || null) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { on: false, updatedAt: null, updatedBy: null };
    return { on: true, updatedAt: null, updatedBy: null, error: "maintenance state could not be read" };
  }
}

function saveMaintenance(state) {
  fs.mkdirSync(path.dirname(MAINTENANCE_FILE), { recursive: true });
  const tmp = `${MAINTENANCE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, MAINTENANCE_FILE);
  return state;
}

function maintenanceAllows(req) {
  const p = req.path;
  if (p === "/admin" || p === "/admin.html" || p === "/api/admin" || p.startsWith("/api/admin/")) return true;
  if (["/api/health", "/api/network-status", "/api/paystack/webhook", "/api/idatagh/webhook", "/api/order/status", "/sw.js", "/manifest.json", "/offline.html"].includes(p)) return true;
  return /^\/(css|js|img)\//.test(p);
}

/* ---------- automatic supplier approval: the owner's switch ----------
   Automatic approval means a card payment is released to the supplier without the
   owner pressing anything. It is a switch, not a setting buried in a file, because
   on 2026-09-29 a customer lost GHS 50 to a wrong-network purchase and the owner
   rightly wanted to decide when their money is spent without asking anyone.

   It defaults to OFF. That is deliberate: after an incident, "nothing moves unless
   I say so" is the safe answer, and the owner turns it on when they are comfortable.

   When it is OFF, a paid order is still recorded as paid, but it is parked as
   awaitingApproval and the owner presses Process. Nothing is ever half-done: the
   payment is never un-credited, it simply waits for a human.

   Toggling it ON does not retroactively send anything that is already waiting. Each
   parked order still needs its own Process press, so turning the switch on can
   never cause a sudden burst of supplier spending. */
const AUTOAPPROVE_FILE = path.join(__dirname, "..", "data", "autoapprove.json");

function autoApproveState() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTOAPPROVE_FILE, "utf8") || "{}");
    if (raw && raw.on !== undefined && typeof raw.on !== "boolean") return { on: false, updatedAt: null, updatedBy: null, error: "auto-approve state is invalid" };
    return { on: raw && raw.on === true, updatedAt: (raw && raw.updatedAt) || null, updatedBy: (raw && raw.updatedBy) || null };
  } catch (e) {
    if (e && e.code === "ENOENT") return { on: false, updatedAt: null, updatedBy: null };
    return { on: false, updatedAt: null, updatedBy: null, error: "auto-approve state could not be read" };
  }
}

function saveAutoApprove(state) {
  fs.mkdirSync(path.dirname(AUTOAPPROVE_FILE), { recursive: true });
  const tmp = `${AUTOAPPROVE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTOAPPROVE_FILE);
  return state;
}

/* ---------- pricing: auto from supplier cost, admin-overridable, promo-aware ----------
   Single source of truth. Every price shown to a customer AND charged by the
   order, wallet-order and bulk-order routes comes from priceFor(). */
const NETWORKS = ["mtn", "telecel", "airteltigo"];
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const PRICING_DEFAULTS = {
  markupPercent: DEFAULT_MARKUP,
  guestMarkupPercent: DEFAULT_GUEST_MARKUP,
  minMarginPercent: 0,
  promo: { active: false, percent: 0, networks: NETWORKS, label: "", endsAt: null },
  overrides: {},
};

function loadPricing() {
  const raw = fs.existsSync(PRICING_FILE) ? JSON.parse(fs.readFileSync(PRICING_FILE, "utf8") || "{}") : {};
  const p = { ...PRICING_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  p.promo = { ...PRICING_DEFAULTS.promo, ...(raw.promo || {}) };
  if (!Array.isArray(p.promo.networks) || !p.promo.networks.length) p.promo.networks = NETWORKS;
  if (!p.overrides || typeof p.overrides !== "object") p.overrides = {};
  return p;
}
function savePricing(p) {
  fs.mkdirSync(path.dirname(PRICING_FILE), { recursive: true });
  const tmp = `${PRICING_FILE}.tmp`;
  p.updated = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, PRICING_FILE);
  return p;
}

function promoLive(promo) {
  if (!promo || !promo.active) return false;
  if (promo.endsAt && Date.parse(promo.endsAt) < Date.now()) return false;
  return true;
}

/** Resolve the price a customer pays for one plan. Never returns less than the margin floor. */
function priceFor(plan, isMember) {
  const cfgP = loadPricing();
  const cost = Number(plan.cost);
  const key = String(plan.id);
  const ov = cfgP.overrides[key];
  const promo = cfgP.promo;
  const promoApplies = promoLive(promo) && promo.networks.map((n) => String(n).toLowerCase()).includes(String(plan.network || "").toLowerCase());
  const promoPct = promoApplies ? clamp(Number(promo.percent) || 0, 0, 100) : 0;
  const markup = clamp(Number(isMember ? cfgP.markupPercent : cfgP.guestMarkupPercent) || 0, -90, 1000);
  const floorPct = clamp(Number(cfgP.minMarginPercent) || 0, 0, 1000);
  const useFloor = floorPct > 0;
  const floor = useFloor ? round2(cost * (1 + floorPct / 100)) : 0;

  let base;
  let source = "auto";
  // A pin sets the MEMBER price (your price for signed-in customers). Guests stay
  // on the guest markup so the walk-in funnel keeps its margin; use a promo to
  // discount everyone at once.
  if (isMember && ov && ov.mode === "fixed" && Number.isFinite(Number(ov.fixed)) && Number(ov.fixed) > 0) {
    base = round2(ov.fixed);
    source = "fixed";
  } else {
    base = round2(cost * (1 + markup / 100));
  }
  const afterPromo = round2(base * (1 - promoPct / 100));
  const final = round2(useFloor ? Math.max(afterPromo, floor) : afterPromo);
  return {
    price: final,
    cost,
    base,
    markupPercent: markup,
    promoPercent: promoPct,
    marginPercent: cost > 0 ? round2(((final - cost) / cost) * 100) : 0,
    source,
    floored: useFloor && afterPromo < floor,
    promoLabel: promoApplies ? (promo.label || "") : "",
  };
}

/** Member and guest prices for a plan, with the same promo/floor rules. */
function bothPrices(plan) {
  const m = priceFor(plan, true);
  const g = priceFor(plan, false);
  return { member: m.price, guest: g.price, memberInfo: m, guestInfo: g };
}

/** "Save ~26%" badge: how much cheaper member is than guest, at the median plan. */
function savePercent() {
  const p = loadPricing();
  if (p.markupPercent >= p.guestMarkupPercent) return 0;
  return Math.round((1 - (1 + p.markupPercent / 100) / (1 + p.guestMarkupPercent / 100)) * 100);
}

const loadOrders = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]"); }
  catch { return []; }
};
const saveOrders = (orders) => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  return orders;
};
/* ---------- blocked beneficiary numbers ----------
   A number the owner has blocked cannot buy a bundle, in any channel (guest, wallet,
   or bulk). This exists because of a real incident on 2026-09-29: an automated
   supplier-send retry loop let one customer farm ~180 GHS of data for a single
   19.30 payment. Blocking is the owner's decision and is reversible. The reason is
   stored so the admin can see why, but it is never shown to the customer (they only
   see a neutral "this number cannot buy data, contact us" message). */
const BLOCK_FILE = path.join(__dirname, "..", "data", "blocked.json");
const loadBlocked = () => {
  try { return JSON.parse(fs.readFileSync(BLOCK_FILE, "utf8") || "[]"); }
  catch { return []; }
};
const saveBlocked = (list) => {
  fs.mkdirSync(path.dirname(BLOCK_FILE), { recursive: true });
  const tmp = `${BLOCK_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, BLOCK_FILE);
  return list;
};
const blockKey = (p) => String(p || "").replace(/\D/g, "").replace(/^233/, "0");
function isBlocked(phone) {
  const key = blockKey(phone);
  if (!key) return false;
  return loadBlocked().some((b) => blockKey(b.phone) === key);
}

function ensureTrackCodes() {
  const orders = loadOrders();
  const used = new Set();
  let changed = false;
  for (const order of orders) {
    let code = String(order.trackCode || "").toUpperCase();
    while (!/^PD-[A-F0-9]{10}$/.test(code) || used.has(code)) code = mintTrackCode();
    if (order.trackCode !== code) { order.trackCode = code; changed = true; }
    used.add(code);
  }
  if (changed) saveOrders(orders);
}
/* Our supplier will not honour two orders for the same number sent at the same
   time: one is rejected and there is no refund. This finds an existing order for
   that number which is still open, so the storefront can refuse the second one
   instead of the owner quietly losing it. */
const SAME_NUMBER_WINDOW_MS = 30 * 60 * 1000;
const OPEN_STATUSES = ["pending", "pending_payment", "paid", "processing"];
function recentOrderForNumber(digits, windowMs) {
  const now = Date.now();
  return loadOrders()
    .filter((o) => o.phone === digits && OPEN_STATUSES.includes(o.status))
    .filter((o) => now - new Date(o.created).getTime() < (windowMs || SAME_NUMBER_WINDOW_MS))
    .sort((a, b) => new Date(b.created) - new Date(a.created))[0] || null;
}

function validatedDupes(rows) {
  const seen = new Set();
  const dupes = new Set();
  for (const r of rows) {
    const phone = String(r.phone || "").replace(/\D/g, "").replace(/^233/, "0");
    if (!phone) continue;
    if (seen.has(phone)) dupes.add(phone);
    seen.add(phone);
  }
  return [...dupes].slice(0, 6);
}

function expireUnpaid() {
  const orders = loadOrders();
  let changed = false;
  const cutoff = Date.now() - 24*60*60*1000;
  for (const o of orders) {
    const old = new Date(o.created).getTime() < cutoff;
    // A MoMo/cash order the customer never paid for, and a card payment they
    // started and abandoned. Neither has taken money or sent data, so clearing
    // them stops them sitting in "Pending attention" forever.
    if (o.status === "pending" && o.source === "manual" && old) {
      o.status = "cancelled";
      o.cancelReason = "auto-cancelled after 24h unpaid";
      changed = true;
    } else if (o.status === "pending_payment" && old) {
      o.status = "cancelled";
      o.cancelReason = "auto-cancelled after 24h, card payment never completed";
      changed = true;
    }
  }
  if (changed) saveOrders(orders);
}

/* ---------- abandoned card top-ups ----------
   A customer who starts a card top-up and walks away left the record at
   "awaiting_payment" forever, where it still counted towards their cap of 3
   waiting payments. So a customer could lock THEMSELVES out of topping up by
   abandoning attempts, and the owner had no way to tell those rows from a genuine
   pending payment. Clearing them after 24h releases the cap.

   This is its own function, scheduled below, because loadTopups is a const defined
   further down the file: calling it from expireUnpaid at boot threw a
   "Cannot access before initialization" error and stopped the server starting. */
function expireAbandonedTopups() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const tops = loadTopups();
  let changed = false;
  for (const t of tops) {
    if (t.status !== "awaiting_payment" || t.credited) continue;
    if (new Date(t.created).getTime() >= cutoff) continue;
    t.status = "cancelled";
    t.error = "expired after 24h, card payment never completed";
    t.handledAt = new Date().toISOString();
    changed = true;
  }
  if (changed) saveTopups(tops);
}
setInterval(expireUnpaid, 60*60*1000).unref();
expireUnpaid();

/* Our supplier only investigates a delivery problem if it is reported within 24
   hours, and will not look at it after that. With MTN queuing for hours that is a
   deadline the owner can easily miss, so an order that has been sitting in
   processing is raised once with its age and the time left to report it. */
const STUCK_AFTER_MS = 3 * 60 * 60 * 1000;     // quiet until it is worth a look
const REPORT_WITHIN_MS = 24 * 60 * 60 * 1000;  // the supplier's hard limit
function watchStuckOrders() {
    const now = Date.now();
    const orders = loadOrders();
    for (const o of orders) {
      // A paid order with no supplier reference has NEVER reached the supplier,
      // whatever its status says. The customer has paid and has nothing. This is
      // the exact state that happened silently on 2026-09-28 and cost a real
      // sale, so it is checked on every pass and cannot be left to a single code
      // path being careful. Anything waiting more than 4 minutes for a first send
      // attempt is treated as a send that never happened.
      if (["paid", "processing", "pending_payment"].includes(o.status) && !o.providerRef) {
        const since = new Date(o.sendFailedAt || o.verifiedAt || o.paidAt || o.created).getTime();
        const waited = now - (Number.isFinite(since) ? since : 0);
        if (!Number.isFinite(waited) || waited < 4 * 60 * 1000) continue;
        const mins = (waited / 60000).toFixed(0);
        alertAdmin("supplier",
          `Order ${o.id} (${o.planName}, GHS ${Number(o.sell).toFixed(2)}, ${o.phone}) has been paid for ${mins} minutes and was NEVER sent to the supplier (no supplier reference). The customer has paid and has no data. Use Send to supplier, or refund them. Reference: ${o.reference}.`,
          `never-sent:${o.id}`);
        continue;
      }
      if (o.status !== "processing") continue;
      // Measured from when the customer placed it, which is the supplier's own clock.
      const age = now - new Date(o.created).getTime();
      if (!Number.isFinite(age) || age < STUCK_AFTER_MS) continue;
      const hours = (age / 3600000).toFixed(1);
      const left = Math.max(0, REPORT_WITHIN_MS - age) / 3600000;
      alertAdmin("supplier", `Order ${o.id} (${o.planName}, GHS ${o.sell}, ${o.phone}) has been processing for ${hours} hours. Report it to the supplier within ${left.toFixed(1)} hours, after which they will not check it.`, `stuck-order:${o.id}`);
    }
  }
setInterval(watchStuckOrders, 30 * 60 * 1000).unref();
setTimeout(watchStuckOrders, 60 * 1000).unref();

/* ---------- card payments: webhook plus a safety net ----------
   Paystack's webhook is the normal path, but it is a setting in someone else's
   dashboard. If it is missing or mis-pointed, a customer who has genuinely paid
   sits at "Card payment not confirmed" and the owner has to approve every order
   by hand. So a background pass asks Paystack directly about any order that has
   been waiting on a card for a little while, and releases it the same way the
   webhook would. It only ever acts while the order is still pending_payment, so
   it can never double-fulfil, and it never releases an order it has not verified
   as paid with Paystack. */
/* The terms the customer must accept before paying. Bumping this means an old
   acceptance can still be shown to have been made against older wording, and the
   admin can tell which version each order agreed to. */
const TERMS_VERSION = "2026-09-26";
function requireTermsAgreed(body) {
  // Deliberately strict: only a real boolean true counts, so a truthy string or
  // a 1 cannot be used to slip past the gate.
  return !!(body && body.terms === true);
}

const RECONCILE_AFTER_MS = 90 * 1000;   // give the webhook first chance
async function reconcileCardPayments() {
  /* SAFETY-NET RECONCILER. It finds card orders that Paystack has confirmed but that
     the webhook did not release (e.g. the webhook URL is not configured), and hands
     them to the SAME guarded autoApproveAndSend() the webhook uses. That function is
     idempotent and never retries, so running this every 60s cannot re-buy a bundle or
     spend the owner's supplier wallet twice on one order. */
  if (!paystack.initialized() || reconciling) return;
  const now = Date.now();
  const due = loadOrders()
    .filter((o) => o.status === "pending_payment" && o.paystackRef)
    .filter((o) => now - new Date(o.created).getTime() > RECONCILE_AFTER_MS)
    .slice(-5);
  if (!due.length) return;
  reconciling = true;
  try {
    for (const candidate of due) {
      let r;
      try { r = await paystack.verify(candidate.paystackRef); }
      catch (e) { continue; }                     // not paid, or Paystack is down
      // paystack.verify() already returns the `data` object, but tolerate an
      // envelope too so this cannot silently stop matching if the helper changes.
      const d = (r && r.data) ? r.data : (r || {});
      const status = String(d.status || "").toLowerCase();
      const paid = d.status === "success" || d.paid === true || !!d.paid_at;
      if (!paid || status === "failed" || status === "abandoned") continue;
      // Re-read: the webhook may have handled it while we were asking Paystack.
      const fresh = loadOrders().find((o) => o.id === candidate.id);
      if (!fresh || fresh.status !== "pending_payment") continue;
      /* Belt and braces. A supplier send that already failed must never be
         repeated on its own, whatever the status field happens to say. iDATA
         states that a second order for the same number in the same period is
         rejected with no refund, and each accepted repeat is a real charge
         against the owner's wallet, so retrying is exactly the thing that
         emptied it. The owner decides per order, by hand, after checking with
         iDATA. */
      if (fresh.sendFailedAt || fresh.sendAttempts || autoSendBlocked(fresh)) continue;
      const expectedKobo = Math.round(Number(fresh.sell) * 100);
      if (Number(d.amount) !== expectedKobo) {
        fresh.status = "failed";
        fresh.error = "Amount mismatch";
        saveOrders([...loadOrders().filter((o) => o.id !== fresh.id), fresh]);
        alertAdmin("security", `Order ${fresh.id} amount mismatch (card verified GHS ${(Number(d.amount) / 100).toFixed(2)}, expected ${Number(fresh.sell).toFixed(2)}), not fulfilled`);
        continue;
      }
      /* Payment is real and the amount matches. Approve and deliver in one guarded
         step. autoApproveAndSend is idempotent: it will not act on an order that has
         already been claimed, and it never retries. */
      await autoApproveAndSend(loadOrders(), fresh);
    }
  } finally { reconciling = false; }
}
let reconciling = false;
setInterval(reconcileCardPayments, 60 * 1000).unref();
setTimeout(reconcileCardPayments, 20 * 1000).unref();

/* ---------- top-ups: the same safety net, because the risk is the same ----------
   A customer wallet top-up by card was credited ONLY by the webhook. Orders were
   hardened against a missed webhook; top-ups were not, which meant a delayed or
   dropped webhook left a customer who had genuinely paid with an empty wallet,
   no alert, and no retry. This asks Paystack directly about any card top-up that
   has been waiting, and credits it exactly the way the webhook does.

   The credit itself lives in creditTopupOnce(), which is the single place a
   wallet is ever topped up, so the webhook and this pass cannot drift and cannot
   both pay for the same top-up. */

const TOPUP_RECONCILE_AFTER_MS = 90 * 1000;

/* The one and only place a wallet is credited for a top-up. Both the webhook and
   the reconciler call this, and it refuses to pay twice: `credited` is the
   durable claim, written before the balance changes, so a replayed webhook and a
   reconciler pass landing together can still only ever credit once. */
function creditTopupOnce(topups, topup) {
  /* Return a consistent shape. This used to return a bare `false` for an
     already-credited top-up while every other path returned an object, so callers
     that read r.error got undefined and logged an alert claiming a PAID top-up
     was not credited. Found by the independent review of 2026-09-29. */
  if (!topup || topup.credited || topup.status === "paid") return { ok: false, alreadyCredited: true, error: "This top-up was already credited, so it was not credited again." };
  const users = loadUsers();
  const u = users.find((x) => x.id === topup.userId);
  if (!u) {
    /* Do not mark it paid. A paid top-up that credited nobody is worse than an
       obvious failure, because the owner sees "approved" and the customer has
       nothing. Leave it for the owner to resolve. */
    topup.error = "No account found for this top-up. Credit it by hand or refund the customer.";
    return { ok: false, error: topup.error };
  }
  const amount = Number(topup.amount) || 0;
  topup.credited = true;                                  // durable claim, before the money moves
  topup.status = "paid";
  topup.handledAt = new Date().toISOString();
  u.wallet = round2(u.wallet + amount);
  topup.walletAfter = u.wallet;
  saveUsers(users);
  creditReferralOnFirstPurchase(u.id);
  activity("topup", `${u.name} paid GHS ${amount.toFixed(2)} by card, credited automatically (${topup.id}). Wallet now GHS ${u.wallet.toFixed(2)}`);
  return { ok: true, user: u, amount };
}

let topupReconciling = false;
async function reconcileCardTopups() {
  if (!paystack.initialized() || topupReconciling) return;
  const now = Date.now();
  const due = loadTopups()
    .filter((t) => t.status === "awaiting_payment" && t.paystackRef)
    .filter((t) => !t.credited)
    .filter((t) => now - new Date(t.created).getTime() > TOPUP_RECONCILE_AFTER_MS)
    .slice(-5);
  if (!due.length) return;
  topupReconciling = true;
  try {
    for (const candidate of due) {
      let d;
      try { d = await paystack.verify(candidate.paystackRef); }
      catch (e) { continue; }                    // not paid, or Paystack is down
      const status = String(d.status || "").toLowerCase();
      const paid = d.status === "success" || d.paid === true || !!d.paid_at;
      if (!paid || status === "failed" || status === "abandoned") continue;
      // The amount is pinned server-side when the payment was created. Only that
      // exact amount may be credited, so a tampered amount cannot create credit.
      const expectedKobo = Math.round(Number(candidate.amount) * 100);
      if (Number(d.amount) !== expectedKobo) {
        const list = loadTopups();
        const t = list.find((x) => x.id === candidate.id);
        if (t) { t.status = "failed"; t.error = "Amount mismatch"; t.handledAt = new Date().toISOString(); saveTopups(list); }
        alertAdmin("security", `Top-up ${candidate.id} amount mismatch (card paid GHS ${(Number(d.amount) / 100).toFixed(2)}, expected GHS ${Number(candidate.amount).toFixed(2)}), NOT credited`);
        continue;
      }
      const list = loadTopups();
      const t = list.find((x) => x.id === candidate.id);
      if (!t || t.credited) continue;            // the webhook got there first
      const r = creditTopupOnce(list, t);
      saveTopups(list);
      if (r.ok) {
        alertAdmin("topup", `GHS ${Number(candidate.amount).toFixed(2)} received from ${r.user.name} by card. Wallet credited automatically (the webhook did not arrive in time).`, `topup-auto:${candidate.id}`);
      } else {
        alertAdmin("security", `Top-up ${candidate.id} was PAID by card but the account could not be found, so it was NOT credited. ${r.error}`, `topup-noacct:${candidate.id}`);
      }
    }
  } finally { topupReconciling = false; }
}
setInterval(reconcileCardTopups, 60 * 1000).unref();
setTimeout(reconcileCardTopups, 25 * 1000).unref();

function mintTrackCode() {
  return `PD-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

const newOrder = () => ({
  id: `YB${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
  trackCode: mintTrackCode(),
  created: new Date().toISOString(),
  status: "pending", // pending | pending_payment | paid | processing | delivered | failed | refunded
  providerRef: null,
  paystackRef: null,
  userId: null,   // set when bought from a registered account wallet
  source: "manual", // manual (guest) | wallet | paystack
});

function applyProviderResult(order, result) {
  const state = result && result.deliveryStatus;
  const message = String((result && result.message) || "Provider accepted the order and is waiting for iDATA to start processing.").slice(0, 300);
  order.providerRef = (result && (result.providerRef || result.reference)) || order.providerRef || null;
  order.providerStatus = (result && result.providerStatus) || null;
  order.providerMessage = message;
  if (state === "delivered") {
    order.status = "delivered";
    order.deliveredAt = new Date().toISOString();
    order.error = null;
  } else if (state === "failed") {
    order.status = "failed";
    order.error = message;
  } else {
    order.status = "processing";
    order.error = null;
    delete order.deliveredAt;
  }
  return order;
}

const PROGRESS_STEPS = [
  { key: "received", label: "Order received" },
  { key: "payment", label: "Payment confirmed" },
  { key: "approved", label: "Order approved" },
  { key: "processing", label: "Network processing" },
  { key: "delivered", label: "Delivered" },
];

function orderProgress(order) {
  const status = String(order.status || "pending");
  const providerText = `${order.providerStatus || ""} ${order.providerMessage || ""}`.toLowerCase();
  let current = "received";
  let label = "Order received";
  if (status === "pending") { current = "received"; label = "Order received, waiting for payment"; }
  else if (status === "pending_payment") { current = "payment"; label = "Payment started, waiting for confirmation"; }
  else if (status === "paid") { current = "payment"; label = "Payment confirmed"; }
  else if (status === "processing") {
    if (/approved|accepted|queued|waiting|pending/.test(providerText)) {
      current = "approved";
      label = "Order approved, waiting for data delivery to begin";
    } else {
      current = "processing";
      label = "Your data is being processed";
    }
  } else if (status === "delivered") { current = "delivered"; label = "Delivered successfully"; }
  else if (status === "failed") { current = "failed"; label = "Delivery needs attention"; }
  else if (status === "refunded") { current = "refunded"; label = "Refunded"; }
  else if (status === "cancelled") { current = "cancelled"; label = "Order cancelled"; }
  const currentIndex = PROGRESS_STEPS.findIndex((step) => step.key === current);
  const steps = PROGRESS_STEPS.map((step, index) => ({
    ...step,
    state: currentIndex >= 0 ? (index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming") : "upcoming",
  }));
  if (["failed", "refunded", "cancelled"].includes(current)) steps.push({ key: current, label, state: "terminal" });
  return { current, label, steps };
}

/* ---------- HTTPS redirect + HSTS (Critical 3) ---------- */
app.use((req, res, next) => {
  const xfp = (req.get("x-forwarded-proto") || "").toLowerCase();
  const cfv = (req.get("cf-visitor") || "").toLowerCase();
  const isHttp = xfp === "http" || cfv.includes('"scheme":"http"');
  const isHttps = req.secure || xfp === "https" || cfv.includes('"scheme":"https"') || req.get("x-forwarded-proto") === "https";
  if (isHttp) {
    const host = req.get("host") || "bundles.example.com";
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  if (isHttps) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  next();
});

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self' https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  next();
});

/* ---------- CSRF Origin check (Medium 4) ---------- */
app.use((req, res, next) => {
  if (req.method === "POST" && req.path.startsWith("/api/")) {
    const origin = req.get("origin") || "";
    if (origin && origin !== "https://bundles.example.com" && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
      return res.status(403).json({ error: "Forbidden origin" });
    }
  }
  next();
});

app.use((req, res, next) => {
  if (!maintenanceState().on || maintenanceAllows(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "The store is temporarily offline for emergency maintenance. Please try again shortly.", maintenance: true });
  }
  return res.status(503).set("Cache-Control", "no-store").sendFile(MAINTENANCE_HTML);
});

/* ---------- in-memory rate limiting ---------- */
const hits = new Map();
const LIMIT_WINDOW = 10 * 60 * 1000;
const ORDER_MAX = Number(cfg("ORDER_RATE_MAX", "5"));
const rateLimit = (winMs, max, opts) => (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || "?";
  const key = (opts && opts.key) || ip;
  const list = (hits.get(key) || []).filter((t) => t > now - winMs);
  if (list.length >= max) {
    res.set("Retry-After", String(Math.ceil(winMs / 1000)));
    return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
  }
  list.push(now);
  hits.set(key, list);
  // A successful request is proof the caller is not guessing, so it is undone
  // again on the way out. The login route uses this: without it, signing in
  // repeatedly (or a test script) burned the whole per-IP budget and locked the
  // owner out of their own admin for the rest of the window.
  if (opts && opts.refundOnSuccess) {
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const l = (hits.get(key) || []).filter((t) => t > Date.now() - winMs);
        l.pop();
        if (l.length) hits.set(key, l); else hits.delete(key);
      }
    });
  }
  next();
};
setInterval(() => {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [ip, list] of hits) {
      const alive = list.filter((t) => t > now - LIMIT_WINDOW);
      if (!alive.length) hits.delete(ip);
      else hits.set(ip, alive);
    }
  }
}, 10 * 60 * 1000).unref();

/* ---------- session admin auth (replaces Basic auth) ---------- */
const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const COOKIE = "idata_admin";
const loginFails = new Map(); // "ip|user" -> [timestamps]
const LOCK_AFTER = Number(cfg("ADMIN_LOCK_AFTER", "5"));
const LOCK_FOR = Number(cfg("ADMIN_LOCK_MS", "900000"));
const ADMIN_BURST_MAX = Number(cfg("ADMIN_BURST_MAX", "15"));

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function adminConfigured() {
  return Boolean(ADMIN_USER && ADMIN_PASS);
}

app.post("/api/admin/login", rateLimit(LIMIT_WINDOW, ADMIN_BURST_MAX, { refundOnSuccess: true }), (req, res) => {
  if (!adminConfigured())
    return res.status(503).json({ error: "Admin is not configured. Set ADMIN_USER and ADMIN_PASS in the environment." });
  const ip = req.ip || "?";
  const user = String((req.body && req.body.user) || "");
  const pass = String((req.body && req.body.pass) || "");
  const key = `${ip}|${user}`;
  const fails = (loginFails.get(key) || []).filter((t) => t > Date.now() - LOCK_FOR);
  if (fails.length >= LOCK_AFTER) {
    res.set("Retry-After", String(Math.ceil(LOCK_FOR / 1000)));
    return res.status(429).json({ error: "Too many failed attempts. Try again later." });
  }
  if (!safeEqual(user, ADMIN_USER) || !safeEqual(pass, ADMIN_PASS)) {
    fails.push(Date.now());
    loginFails.set(key, fails);
    const left = LOCK_AFTER - fails.length;
    return res.status(401).json({ error: "Invalid credentials.", remaining: left });
  }
  loginFails.delete(key);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: req.secure || cfg("FORCE_SECURE_COOKIE", "1") === "1",
    maxAge: SESSION_TTL,
    path: "/",
  });
  res.json({ ok: true, user });
});

app.post("/api/admin/logout", (req, res) => {
  const t = (req.cookies && req.cookies[COOKIE]) || (req.headers.cookie || "").split(/;\s*/)
    .map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1] || null;
  if (t && sessions.has(t)) sessions.delete(t);
  res.clearCookie(COOKIE, { path: "/", httpOnly: true, sameSite: "Strict" });
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const token = m ? decodeURIComponent(m.split("=").slice(1).join("=")) : null;
  const s = token && sessions.get(token);
  if (!s) return res.status(401).json({ error: "Admin login required." });
  if (s.exp < Date.now()) { sessions.delete(token); return res.status(401).json({ error: "Session expired. Login again." }); }
  req.admin = { token, user: s.user };
  next();
}

/* ---------- change the admin password from the dashboard ---------- */
const ENV_FILE = path.join(__dirname, ".env");

function writeEnvValue(key, value) {
  let raw;
  try { raw = fs.readFileSync(ENV_FILE, "utf8"); }
  catch { return { ok: false, error: "The server .env file is not readable, so the password was not changed." }; }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(raw) ? raw.replace(re, line) : `${raw.replace(/\s*$/, "")}\n${line}\n`;
  const tmp = `${ENV_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, ENV_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: "Could not write the new password: " + e.message };
  }
  return { ok: true };
}

/* ---------- supplier / payment secrets, changed from the dashboard ----------
   On 2026-09-29 the supplier API key had to be pasted into a chat to be installed,
   which is how it ended up readable by anyone with that transcript. This lets the
   owner rotate a key in iDATA's own dashboard and paste the replacement straight
   into the admin, so the secret never travels through a conversation again.

   Three deliberate restraints:
     - the stored value is NEVER sent back to the browser. Only "is it set" and
       the last 4 characters, which is enough to tell two keys apart and useless
       to anyone who intercepts the response.
     - changing one of these requires the current admin password again, exactly
       like changing the password itself. A stolen session cookie must not be able
       to repoint the supplier at somebody else's account, which would hand over
       every future order and the key itself.
     - a new supplier key is proved against the live iDATA API before it is
       accepted, so a bad paste is caught here rather than on a customer's order. */

const SECRET_FIELDS = [
  { key: "IDATAGH_API_KEY", label: "iDATA supplier API key", test: "supplier" },
  { key: "IDATAGH_WEBHOOK_SECRET", label: "iDATA webhook signing secret", test: null },
  { key: "PAYSTACK_SECRET_KEY", label: "Paystack secret key", test: "paystack" },
];

const secretStatus = (value) => {
  const v = String(value || "");
  if (!v) return { set: false, last4: null };
  return { set: true, last4: v.slice(-4) };
};

app.get("/api/admin/credentials", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  res.json({
    secrets: SECRET_FIELDS.map((f) => ({
      key: f.key,
      label: f.label,
      ...secretStatus(cfg(f.key)),
    })),
    supplierUrl: cfg("IDATAGH_API_URL") || null,
    canWrite: (() => { try { fs.accessSync(ENV_FILE, fs.constants.W_OK); return true; } catch { return false; } })(),
  });
});

app.put("/api/admin/credentials", requireAdmin, rateLimit(LIMIT_WINDOW, 10), async (req, res) => {
  const current = String((req.body && req.body.current) || "");
  if (!safeEqual(current, ADMIN_PASS)) return res.status(401).json({ error: "Current password is not correct." });

  const updates = [];
  for (const f of SECRET_FIELDS) {
    const raw = req.body ? req.body[f.key] : undefined;
    if (raw === undefined) continue;                       // field not being changed
    const v = String(raw);
    if (!v) { updates.push({ ...f, value: "" }); continue; } // explicit clear
    if (/[\r\n]/.test(v)) return res.status(400).json({ error: `${f.label} cannot contain line breaks.` });
    if (v !== v.trim()) return res.status(400).json({ error: `${f.label} cannot start or end with a space.` });
    if (v.length < 8 || v.length > 400) return res.status(400).json({ error: `${f.label} looks the wrong length (need 8-400 characters).` });
    updates.push({ ...f, value: v });
  }
  if (!updates.length) return res.status(400).json({ error: "Nothing to change." });

  /* Prove a new supplier/paystack key against the live API BEFORE writing it, so a
     typo cannot be saved and then break the next customer's order. */
  for (const u of updates) {
    if (u.value && u.test === "supplier") {
      const before = cfg(u.key);
      process.env[u.key] = u.value;
      idatagh.clearCache();
      let ok = false, err = "";
      try { await idatagh.walletBalance(); ok = true; }
      catch (e) { err = String(e.message || e).slice(0, 200); }
      if (!ok) {
        process.env[u.key] = before;      // put the old key back untouched
        idatagh.clearCache();
        return res.status(400).json({ error: `That supplier key was rejected by iDATA, so it was NOT saved. ${err}` });
      }
    }
    if (u.value && u.test === "paystack") {
      const before = cfg(u.key);
      process.env[u.key] = u.value;
      let ok = false, err = "";
      try { ok = await paystack.verify("pdh-credential-check"); } catch (e) { err = String(e.message || e).slice(0, 200); }
      // A reference that does not exist still proves the key authenticated, unless
      // the error is an auth failure. Anything else is treated as valid so a
      // Paystack wording change cannot block a legitimate key.
      if (/authentic|invalid[_ ]key|unauthor/i.test(err)) {
        process.env[u.key] = before;
        return res.status(400).json({ error: `That Paystack key was rejected, so it was NOT saved. ${err}` });
      }
      ok = true;
    }
  }

  const written = [];
  for (const u of updates) {
    const w = writeEnvValue(u.key, u.value);
    if (!w.ok) return res.status(500).json({ error: w.error });
    process.env[u.key] = u.value;            // take effect now, no restart needed
    written.push(u.key);
  }
  if (updates.some((u) => u.test === "supplier")) idatagh.clearCache();

  const names = updates.map((u) => u.label).join(", ");
  activity("security", `secret updated from the dashboard: ${names} (values not logged)`);
  alertAdmin("security", `Secret updated: ${names}. Old value is no longer used by this site. If the old key was exposed anywhere, revoke it there too.`, `secret-updated:${updates.map((u) => u.key).join(",")}`);

  res.json({
    ok: true,
    updated: written,
    secrets: SECRET_FIELDS.map((f) => ({ key: f.key, label: f.label, ...secretStatus(cfg(f.key)) })),
  });
});

app.post("/api/admin/password", requireAdmin, rateLimit(LIMIT_WINDOW, 8), (req, res) => {
  const current = String((req.body && req.body.current) || "");
  const next = String((req.body && req.body.next) || "");
  if (!safeEqual(current, ADMIN_PASS)) return res.status(401).json({ error: "Current password is not correct." });
  if (next.length < 8 || next.length > 128) return res.status(400).json({ error: "New password must be 8-128 characters." });
  if (/[\r\n]/.test(next)) return res.status(400).json({ error: "Password cannot contain line breaks." });
  if (next !== next.trim()) return res.status(400).json({ error: "Password cannot start or end with a space." });
  if (next === current) return res.status(400).json({ error: "New password must be different from the current one." });

  const w = writeEnvValue("ADMIN_PASS", next);
  if (!w.ok) return res.status(500).json({ error: w.error });

  ADMIN_PASS = next;              // take effect now, no restart needed
  process.env.ADMIN_PASS = next;
  loginFails.clear();             // a fresh password should not inherit lockouts
  for (const [t, s] of sessions) if (t !== req.admin.token) sessions.delete(t);
  activity("auth", `admin password changed by ${req.admin.user}; other sessions signed out`);
  res.json({ ok: true, otherSessionsSignedOut: sessions.size > 0 });
});

app.get("/api/admin/session", (req, res) => {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const token = m ? decodeURIComponent(m.split("=").slice(1).join("=")) : null;
  const s = token && sessions.get(token);
  if (!s) return res.status(401).json({ error: "Not logged in." });
  if (s.exp < Date.now()) { sessions.delete(token); return res.status(401).json({ error: "Expired." }); }
  res.json({ user: s.user });
});

/* ---------- messaging: one-off 6-digit codes for admin test sends ---------- */
const genOtp = () => String(crypto.randomInt(100000, 1000000));

/* ---------- Messaging providers: WhatsApp Cloud API + SMS fallbacks ---------- */
const WA_VER = cfg("WHATSAPP_API_VERSION", "v25.0");
const WA_TOKEN = cfg("WHATSAPP_TOKEN");
const WA_PHONE_ID = cfg("WHATSAPP_PHONE_ID");
const WA_APP_SECRET = cfg("WHATSAPP_APP_SECRET");
const WA_VERIFY_TOKEN = cfg("WHATSAPP_VERIFY_TOKEN");
const WA_OTP_TEMPLATE = cfg("WHATSAPP_OTP_TEMPLATE", "");
const WA_OTP_LANG = cfg("WHATSAPP_OTP_LANG", "en");
const ARKSEL_KEY = cfg("ARKESEL_API_KEY");
const ARKSEL_SENDER = cfg("ARKESEL_SENDER", "POLYMATH");
const AT_USER = cfg("AT_USERNAME");
const AT_KEY = cfg("AT_API_KEY");

const msgMockOn = () => cfg("MSG_MOCK", cfg("OTP_MOCK", "0")) === "1";
const waOn = () => Boolean(WA_TOKEN && WA_PHONE_ID);
const smsOn = () => Boolean(ARKSEL_KEY || (AT_USER && AT_KEY));
const msgChannel = () => (msgMockOn() ? "mock" : waOn() ? "whatsapp" : smsOn() ? "sms" : "none");
const waIntl = (phone) => {
  const d = String(phone).replace(/\D/g, "");
  if (d.startsWith("233")) return d;
  if (d.startsWith("0")) return `233${d.slice(1)}`;
  return d;
};

async function postJson(url, headers, body, timeoutMs = 12000) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

function waPayload(to, code) {
  if (WA_OTP_TEMPLATE) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WA_OTP_TEMPLATE,
        language: { code: WA_OTP_LANG },
        components: [{ type: "body", parameters: [{ type: "text", text: String(code) }] }],
      },
    };
  }
  return { messaging_product: "whatsapp", to, type: "text", text: { body: `${SITE_NAME}: your code is ${code}. Valid for 5 minutes.` } };
}

async function sendWhatsapp(phone, code) {
  const to = waIntl(phone);
  const r = await postJson(
    `https://graph.facebook.com/${WA_VER}/${WA_PHONE_ID}/messages`,
    { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    waPayload(to, code)
  );
  if (r.ok) {
    const id = r.data && r.data.messages && r.data.messages[0] && r.data.messages[0].id;
    return { ok: true, channel: "whatsapp", to, id: id || null, template: WA_OTP_TEMPLATE || "text" };
  }
  const err = (r.data && r.data.error) || {};
  return {
    ok: false,
    channel: "whatsapp",
    to,
    error: `${err.code || r.status}: ${err.message || "send failed"}`.slice(0, 240),
  };
}

async function sendArkesel(phone, code) {
  const to = waIntl(phone);
  const r = await postJson(
    "https://sms.arkesel.com/api/v2/sms/send",
    { "api-key": ARKSEL_KEY, "Content-Type": "application/json" },
    { sender: ARKSEL_SENDER, message: `${SITE_NAME}: your code is ${code}. Valid for 5 minutes.`, recipients: [to] }
  );
  if (r.ok) return { ok: true, channel: "arksel", to };
  const msg = (r.data && (r.data.message || r.data.error)) || r.data.raw || "send failed";
  return { ok: false, channel: "arksel", to, error: String(msg).slice(0, 240) };
}

async function sendAfricaTalking(phone, code) {
  const body = new URLSearchParams({
    username: AT_USER,
    to: waIntl(phone),
    message: `${SITE_NAME}: your code is ${code}. Valid for 5 minutes.`,
    from: cfg("AT_SENDER_ID", ""),
  }).toString();
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey: AT_KEY, Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  if (res.ok) {
    let data = {};
    try { data = JSON.parse(text); } catch {}
    const num = (data && data.SMSMessageData && data.SMSMessageData[0] && data.SMSMessageData[0].status) || 0;
    if (Number(num) >= 0) return { ok: true, channel: "africastalking", to: waIntl(phone) };
    return { ok: false, channel: "africastalking", to: waIntl(phone), error: `AT status ${num}` };
  }
  return { ok: false, channel: "africastalking", to: waIntl(phone), error: `AT ${res.status}: ${text.slice(0, 160)}` };
}

async function sendOtp(phone, code) {
  if (msgMockOn()) {
    console.log(`[WhatsApp mock] ${phone} -> ${code}`);
    return { ok: true, channel: "mock" };
  }
  const tried = [];
  const chain = [];
  if (waOn()) chain.push(["whatsapp", sendWhatsapp]);
  if (ARKSEL_KEY) chain.push(["arksel", sendArkesel]);
  if (AT_USER && AT_KEY) chain.push(["africastalking", sendAfricaTalking]);
  for (const [name, fn] of chain) {
    try {
      const r = await fn(phone, code);
      if (r.ok) return r;
      tried.push(r);
    } catch (e) {
      tried.push({ ok: false, channel: name, error: String(e.message || e).slice(0, 240) });
    }
  }
  const error = tried.map((t) => `${t.channel}: ${t.error}`).join(" | ") || "No messaging provider configured";
  console.log(`[OTP] delivery failed for ${phone}, ${error}`);
  return { ok: false, channel: "none", error };
}

const MSG_CHANNEL_LABEL = {
  whatsapp: "WhatsApp",
  arkesel: "SMS",
  africastalking: "SMS",
  mock: "your phone (test mode)",
  none: "your phone",
};

/* ---------- persistent stores: users, top-ups, activity ---------- */
const USERS_FILE = path.join(__dirname, "..", "data", "users.json");
const TOPUPS_FILE = path.join(__dirname, "..", "data", "topups.json");
const ACTIVITY_FILE = path.join(__dirname, "..", "data", "activity.json");
const STATUS_FILE = path.join(__dirname, "..", "data", "network_status.json");
const SAVED_NUMS_FILE = path.join(__dirname, "..", "data", "saved_numbers.json");
const REFERRALS_FILE = path.join(__dirname, "..", "data", "referrals.json");
const NOTICE_FILE = path.join(__dirname, "..", "data", "notice.json");
const ACTIVITY_MAX = 2000;

const loadJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8") || JSON.stringify(fallback)); }
  catch { return fallback; }
};
const saveJson = (f, arr) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, f);
  return arr;
};
const loadUsers = () => loadJson(USERS_FILE, []);
const saveUsers = (u) => saveJson(USERS_FILE, u);
const loadTopups = () => loadJson(TOPUPS_FILE, []);
const saveTopups = (t) => saveJson(TOPUPS_FILE, t);

/* Scheduled here, not with expireUnpaid, so the const above is initialised first. */
setInterval(expireAbandonedTopups, 60 * 60 * 1000).unref();
setTimeout(expireAbandonedTopups, 5 * 1000).unref();
const loadActivity = () => loadJson(ACTIVITY_FILE, []);
function activity(type, msg) {
  const list = loadActivity();
  list.unshift({ t: new Date().toISOString(), type, msg: String(msg).slice(0, 200) });
  saveJson(ACTIVITY_FILE, list.slice(0, ACTIVITY_MAX));
}

/* Owner alerts: things that need a human, surfaced on the admin dashboard.
   Kept separate from activity so it cannot be buried by routine events. */
const ALERTS_FILE = path.join(__dirname, "..", "data", "alerts.json");
const ALERT_REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000;
function alertAdmin(type, msg, dedupeKey) {
  try {
    const text = String(msg).slice(0, 240);
    const now = Date.now();
    const list = loadJson(ALERTS_FILE, []);
    // The supplier watch is debounced in memory, but a restart resets that, so the
    // same warning used to be re-raised every time the service started. Suppress a
    // repeat of the same condition within the window, whatever caused it. Dedupe
    // is on the condition key, not the wording, so a balance that jitters by a few
    // pesewas does not produce a new warning either.
    const match = list.find((a) => {
      if (now - Date.parse(a.t) >= ALERT_REPEAT_WINDOW_MS) return false;
      // Match on the condition key, but fall back to the wording so rows written
      // before dedupeKey existed still suppress a repeat.
      if (dedupeKey && a.dedupeKey === dedupeKey) return true;
      return a.msg === text && a.type === type;
    });
    if (match) {
      match.count = (Number(match.count) || 1) + 1;
      match.lastAt = new Date().toISOString();
      saveJson(ALERTS_FILE, list.slice(0, 100));
      console.log(`[ALERT ${type}] repeated ${match.count}x (suppressed): ${text.slice(0, 160)}`);
      return;
    }
    list.unshift({ t: new Date().toISOString(), type, msg: text, seen: false, count: 1, dedupeKey: dedupeKey || null });
    saveJson(ALERTS_FILE, list.slice(0, 100));
  } catch (_) {}
  console.log(`[ALERT ${type}] ${String(msg).slice(0, 200)}`);
}
const loadAlerts = () => loadJson(ALERTS_FILE, []);

/* Old builds re-raised the same supplier warning on every restart, so the list
   filled with identical rows. Collapse them into one row that keeps the count.
   Idempotent, so it is safe to run on every boot. */
function collapseDuplicateAlerts() {
  try {
    const list = loadJson(ALERTS_FILE, []);
    if (!Array.isArray(list) || !list.length) return;
    const byMsg = new Map();
    const kept = [];
    for (const a of list) {
      const k = `${a.type}|${a.msg}`;
      const prev = byMsg.get(k);
      if (prev) {
        prev.count = (Number(prev.count) || 1) + (Number(a.count) || 1);
        if (String(a.t) > prev.t) prev.t = a.t;
        continue;
      }
      const row = { ...a, count: Number(a.count) || 1 };
      byMsg.set(k, row);
      kept.push(row);
    }
    if (kept.length !== list.length) {
      saveJson(ALERTS_FILE, kept);
      console.log(`[alerts] collapsed ${list.length} alerts into ${kept.length}`);
    }
  } catch (e) { console.log("[alerts] collapse skipped:", e.message); }
}

app.get("/api/admin/maintenance", requireAdmin, (req, res) => {
  res.json(maintenanceState());
});

app.put("/api/admin/maintenance", requireAdmin, rateLimit(LIMIT_WINDOW, 20), (req, res) => {
  if (!req.body || typeof req.body.on !== "boolean") return res.status(400).json({ error: "Maintenance must be true or false." });
  const state = saveMaintenance({ on: req.body.on, updatedAt: new Date().toISOString(), updatedBy: req.admin.user });
  activity("maintenance", `emergency site maintenance ${state.on ? "enabled" : "disabled"} by ${req.admin.user}`);
  res.json(state);
});

/* The owner's automatic-approval switch. OFF means a paid order is recorded and
   then waits for the owner, and no supplier call is ever made without a press. */
app.get("/api/admin/autoapprove", requireAdmin, (req, res) => {
  res.json(autoApproveState());
});

app.put("/api/admin/autoapprove", requireAdmin, rateLimit(LIMIT_WINDOW, 20), (req, res) => {
  if (!req.body || typeof req.body.on !== "boolean") return res.status(400).json({ error: "Automatic approval must be true or false." });
  const state = saveAutoApprove({ on: req.body.on, updatedAt: new Date().toISOString(), updatedBy: req.admin.user });
  activity("order", `automatic supplier approval turned ${state.on ? "ON" : "OFF"} by ${req.admin.user}`);
  alertAdmin(
    state.on ? "topup" : "security",
    state.on
      ? `Automatic approval is now ON. Card payments will be sent to the supplier automatically, once each, with no retry.`
      : `Automatic approval is now OFF. Paid orders will wait for you to press Process, and nothing reaches the supplier until you do.`,
    `autoapprove:${state.on ? "on" : "off"}`,
  );
  res.json(state);
});

function hashPass(salt, pass) {
  return crypto.createHash("sha256").update(`${salt}::${pass}`).digest("hex");
}
/* Passwords for accounts created by hand (no Google) use scrypt, which is the
   same primitive used by a well-reviewed password library, and is far slower to attack than the
   single sha256 above. That older hash stays for records created before this, and
   a legacy account can be "upgraded" to scrypt the first time it signs in. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
function newSalt() { return crypto.randomBytes(16).toString("hex"); }
function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
/* Timing-safe: a wrong password must take the same work as a right one, so the
   response time cannot be used to guess which accounts exist. */
function verifyPassword(user, pw) {
  if (!user || !user.salt || !user.passHash) return false;
  const legacy = !user.passAlgo;
  const given = legacy
    ? Buffer.from(hashPass(user.salt, pw), "hex")
    : crypto.scryptSync(String(pw), user.salt, 64);
  const expected = Buffer.from(user.passHash, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function passwordProblem(pw) {
  if (typeof pw !== "string") return "Choose a password.";
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return "Password is too long.";
  // A newline in the value would be read as a second line if this were ever
  // written to a config file, and leading/trailing spaces are a classic
  // un-reproducible-password trap.
  if (/[\r\n]/.test(pw)) return "Password cannot contain a line break.";
  if (pw !== pw.trim()) return "Password cannot start or end with a space.";
  return null;
}
const normEmail = (v) => String(v == null ? "" : v).toLowerCase().trim();
function emailProblem(v) {
  const e = normEmail(v);
  if (!e) return "Enter your email address.";
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That email address does not look right.";
  return null;
}
const normPhone = (raw) => {
  const d = String(raw == null ? "" : raw).replace(/\D+/g, "");
  if (d.length === 12 && d.startsWith("233")) return d;
  if (d.length === 10 && d.startsWith("0")) return `233${d.slice(1)}`;
  if (d.length === 9 && /^[23]/.test(d)) return `233${d}`;
  return "";
};
function phoneProblem(v) {
  const p = normPhone(v);
  if (!p) return "Enter a valid Ghana number, for example 0241234567.";
  return null;
}
const publicId = () => `U${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
function userPublic(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || null, wallet: u.wallet, created: u.created };
}

/* ---------- customer account sessions ---------- */
/* Sessions used to live only in a Map, so every service restart signed out every
   customer while their cookie still claimed 30 days of validity. That produced
   exactly the report this whole investigation chased: "I sign in and it signs me
   out", with the server log showing a clean success. They are now written to disk
   so a restart, a crash or a deploy cannot end a session. The token is a random
   48-char secret, so the file is a bearer-token store and is kept 600. */
const USESSIONS_FILE = path.join(__dirname, "..", "data", "user-sessions.json");
const uSessions = new Map(Object.entries(loadJson(USESSIONS_FILE, {})));
const USESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const UCOOKIE = "idata_user";
let uSessionsDirty = false;
function persistUSessions() {
  if (!uSessionsDirty) return;
  uSessionsDirty = false;
  try { saveJson(USESSIONS_FILE, Object.fromEntries(uSessions)); } catch (e) { console.error("[user sessions] could not save:", e.message); }
}
const rememberSession = (token, rec) => { uSessions.set(token, rec); uSessionsDirty = true; };
const forgetSession = (token) => { if (uSessions.delete(token)) uSessionsDirty = true; };
/* Persist on the way out and on a timer, so a crash loses at most a few seconds
   and a clean restart loses nothing. */
process.on("exit", persistUSessions);
process.on("SIGTERM", () => { persistUSessions(); process.exit(0); });
process.on("SIGINT", () => { persistUSessions(); process.exit(0); });
const uSessionFlush = setInterval(persistUSessions, 5000);
uSessionFlush.unref();
if (uSessions.size) console.log(`customer sessions restored: ${uSessions.size}`);
const userCookieOpts = (req) => ({
  httpOnly: true,
  // Lax, not Strict. A Strict cookie is withheld on any navigation that started
  // cross-site, and a Google sign-in arrives from accounts.google.com, so Strict
  // made the browser set the cookie and then refuse to send it straight back. The
  // customer was signed in for one request and appeared logged out on the next.
  // Lax still blocks the cross-site POSTs that CSRF relies on, and is what OAuth
  // redirect flows are built around.
  sameSite: "Lax",
  secure: req.secure || cfg("FORCE_SECURE_COOKIE", "1") === "1",
  maxAge: USESSION_TTL,
  path: "/",
});

function userFromReq(req) {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${UCOOKIE}=`));
  const token = m ? decodeURIComponent(m.split("=").slice(1).join("=")) : null;
  const s = token && uSessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { forgetSession(token); return null; }
  return s;
}
function requireUser(req, res, next) {
  const s = userFromReq(req);
  if (!s) return res.status(401).json({ error: "Sign in to continue." });
  req.user = { id: s.id };
  next();
}

/* ---------- customer auth ---------- */
app.post("/api/auth/logout", (req, res) => {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${UCOOKIE}=`));
  const token = m ? decodeURIComponent(m.split("=").slice(1).join("=")) : null;
  if (token) forgetSession(token);
  res.clearCookie(UCOOKIE, { path: "/" });
  res.json({ ok: true });
});

  app.get("/api/auth/me", (req, res) => {
    const s = userFromReq(req);
    if (!s) {
      // Signed out is the normal state for most visitors, so only log it when the
      // browser actually presented a cookie. A cookie that arrives and is then
      // refused means the session was lost (a service restart clears the in-memory
      // store) rather than the customer never having signed in. That distinction
      // is the whole diagnosis, and it was previously invisible.
      const presented = /idata_user=/.test(req.headers.cookie || "");
      if (presented) console.log(`[google auth] SESSION LOST cookie presented but unknown to this process (restarted? or signed out) ip=${req.ip || "-"}`);
      return res.status(401).json({ error: "Not signed in." });
    }
    const user = loadUsers().find((u) => u.id === s.id);
    if (!user) return res.status(401).json({ error: "Account not found." });
    res.json(userPublic(user));
  });

/* ---------- Google OAuth ---------- */
/* The callback deliberately does NOT live under /api/.

   A Cloudflare Worker bound to this domain intercepts /api/auth/google and
   /api/auth/google/callback and answers the browser itself instead of passing the
   origin's response through. Proven three ways: the callback returns none of our
   security headers while /api/auth/me returns all of them, it reports
   cfOrigin;dur=0 so the origin is never asked, and a full sign-in produced
   "signed in" in the log but ZERO ticket redemptions, meaning even the response
   body never reached the browser.

   Moving the callback to /auth/google/callback puts it outside the Worker's
   interception entirely, so the Set-Cookie and the page both arrive intact. Paths
   outside /api/ were verified to pass through to the origin. The old /api path is
   still accepted as an alias, so an existing authorised redirect URI keeps working
   while a new one takes effect. */
const GOOGLE_CLIENT_ID = cfg("GOOGLE_CLIENT_ID", "");
const GOOGLE_CALLBACK_PATH = cfg("GOOGLE_CALLBACK_PATH", "/auth/google/callback");
const googleRedirectUri = () => `${PUBLIC_BASE || cfg("PUBLIC_BASE_URL", "https://bundles.example.com")}${GOOGLE_CALLBACK_PATH}`;
const GOOGLE_CLIENT_SECRET = cfg("GOOGLE_CLIENT_SECRET", "");
const OAUTH_STATE = new Map();
/* Sign-in was the one flow with no trace anywhere, so a customer saying "I cannot
   sign in" was undiagnosable: the only symptom was a bare error string with no log
   line on either side of it. Every step below logs, so the next occurrence names
   its own cause. Never log the code or the token. */
const oauthLog = (step, detail) => console.log(`[google auth] ${step}${detail ? " " + detail : ""}`);
/* Records the reason in the log and the admin activity trail, and returns the
   heading/detail for the failure page. Never returns a status code, so a caller
   can never accidentally return it instead of sending a response. */
function oauthFail(step, detail, heading, pageDetail) {
  oauthLog("FAIL", `${step}${detail ? " " + detail : ""}`);
  activity("auth", `Google sign-in failed at ${step}${detail ? `: ${detail}` : ""}`);
  return oauthFailPageHTML(heading, pageDetail);
}
/* Assets are served with a one-year immutable cache, so the stylesheet link must
   carry a version or a fixed sign-in page would keep the old CSS forever. Read
   from the homepage so there is one number to keep correct, and fall back to 0. */
function styleVersion() {
  try {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    const m = html.match(/style\.css\?v=(\d+)/);
    return m ? m[1] : "0";
  } catch { return "0"; }
}
const STYLE_V = styleVersion();

/* Escapes a URL for use inside a double-quoted HTML attribute. The Google URL is
   built by us, but it is assembled from config and query values, so it is escaped
   rather than trusted. */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* True when the client is a browser rather than a script. Browsers ask for HTML;
   fetch() and curl do not. Used to send a page instead of a redirect. */
function wantsHtml(req) {
  return /\btext\/html\b/i.test(String(req.headers.accept || ""));
}

/* A sign-in failure must never be a dead end: the customer is told what happened
   and given the way through that does not need an account. Every field is a
   literal string from this file, never anything a customer or Google supplied,
   so nothing here needs escaping. */
function oauthFailPageHTML(heading, detail) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in did not complete</title>
<link rel="stylesheet" href="/css/style.css?v=${STYLE_V}"></head>
<body class="oauth-page"><main class="oauth-card">
<h1>${heading}</h1>
<p>${detail}</p>
<p class="oauth-actions">
<a class="btn btn-primary" href="/api/auth/google?next=/account">Try sign in again</a>
<a class="btn btn-ghost" href="/">Back to the shop</a>
</p>
<p class="oauth-note">You do not need an account to buy. Choose a bundle, enter your
number, and pay by card or mobile money as a guest.</p>
</main></body></html>`;
}
/* ---------- one-time sign-in tickets ----------
   A Cloudflare Worker is bound to this domain and intercepts exactly
   /api/auth/google and /api/auth/google/callback, answering the browser itself
   instead of passing the origin's response through. Proved by request: the same
   Accept header gets our security headers back from /api/auth/me but none at all
   from the callback, and the callback reports cfOrigin;dur=0, so the origin is
   never asked.

   The consequence was severe and silent: the callback DID verify Google, DID
   create the session and DID set the cookie, and logged all three, but the Worker
   never delivered the Set-Cookie to the browser. The customer landed on the
   account page with no session, was shown the sign-up form again, and pressing
   Google again started the whole loop. Six customers had signed in; we cannot
   know whether any of them stayed signed in.

   The fix does not need Cloudflare access. The callback now hands over a
   short-lived single-use ticket and sends the browser to a normal page, which
   redeems the ticket on /api/auth/exchange. That path is NOT matched by the
   Worker, so its Set-Cookie reaches the browser. The ticket is what makes this
   safe rather than a back door: it is random, lives 60 seconds, is consumed by
   the first redemption, and carries only the user id. */
const XCHG_FILE = path.join(__dirname, "..", "data", "auth-exchange.json");
const xchgTickets = new Map(Object.entries(loadJson(XCHG_FILE, {})));
const XCHG_TTL = 60 * 1000;
let xchgDirty = false;
const persistXchg = () => {
  if (!xchgDirty) return;
  xchgDirty = false;
  try { saveJson(XCHG_FILE, Object.fromEntries(xchgTickets)); } catch (e) { console.error("[auth exchange] save failed:", e.message); }
};
process.on("exit", persistXchg);
setInterval(persistXchg, 5000).unref();
function issueExchangeTicket(userId) {
  const now = Date.now();
  for (const [k, v] of xchgTickets) if (v.exp < now) xchgTickets.delete(k);
  const code = crypto.randomBytes(24).toString("hex");
  xchgTickets.set(code, { userId, exp: now + XCHG_TTL });
  xchgDirty = true;
  return code;
}
/* Redeems a ticket and sets the cookie. Used by the callback for the direct path
   and by /api/auth/exchange for the path the Worker does not intercept. Returns
   the user, or null if the ticket is unknown, expired or already used. */
function redeemAuthTicket(code, req, res) {
  const rec = code ? xchgTickets.get(code) : null;
  if (code) { xchgTickets.delete(code); xchgDirty = true; }
  if (!rec || rec.exp < Date.now()) return null;
  const user = loadUsers().find((u) => u.id === rec.userId);
  if (!user) return null;
  const token = crypto.randomBytes(24).toString("hex");
  rememberSession(token, { id: user.id, exp: Date.now() + USESSION_TTL });
  res.cookie(UCOOKIE, token, userCookieOpts(req));
  return user;
}
app.post("/api/auth/exchange", (req, res) => {
  const code = String((req.body && req.body.code) || "");
  const user = redeemAuthTicket(code, req, res);
  if (!user) return res.status(400).json({ error: "This sign-in link is no longer valid. Please sign in again." });
  oauthLog("exchange redeemed", `user=${user.id}`);
  res.json({ ok: true, user: userPublic(user) });
});

app.get("/api/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(503).json({ error: "Google sign-in not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env" });
  const state = crypto.randomBytes(16).toString("hex");
  const rawNext = String(req.query.next || "/account");
  const safeNext = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.includes("://") && !rawNext.includes("\\") ? rawNext : "/account";
  OAUTH_STATE.set(state, { next: safeNext, exp: Date.now() + 10*60*1000 });
  setTimeout(() => OAUTH_STATE.delete(state), 10*60*1000);
  const redirectUri = googleRedirectUri();
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent("openid email profile")}&state=${state}&prompt=select_account`;
  oauthLog("start", `state=${state.slice(0, 8)} next=${safeNext} ip=${req.ip || "-"}`);
  /* A Cloudflare Worker bound to bundles.example.com answers HTML requests itself and
     drops the Location header, so a 302 is rendered as its fallback body instead of
     being followed and the phone shows raw text. Proven by the same URL keeping its
     Location header for non-HTML requests while the origin is never contacted for
     HTML ones (cfOrigin;dur=0). A 200 with a meta refresh needs no header at all, and
     HTML pages are the one response type that still passes through this Worker, so
     this works whether or not the Worker is ever removed. A real link is also in the
     body, so sign-in still works if meta refresh is blocked. */
  if (wantsHtml(req)) {
    const safe = escapeAttr(url);
    return res.status(200).type("html").set("Cache-Control", "no-store").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Taking you to Google</title><link rel="stylesheet" href="/css/style.css?v=${STYLE_V}"></head>
<body class="oauth-page"><main class="oauth-card">
<h1>Taking you to Google</h1>
<p>You are being sent to Google to finish signing in. This should only take a moment.</p>
<p class="oauth-actions"><a class="btn btn-primary" href="${safe}">Continue to Google</a>
<a class="btn btn-ghost" href="/">Back to the shop</a></p>
<p class="oauth-note">If nothing happens, use the Continue to Google button above.</p>
</main></body></html>`);
  }
  res.redirect(url);
});
const googleCallbackHandler = async (req, res) => {
  try {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const errParam = String(req.query.error || "");
    if (errParam) {
      // Google refused or the customer backed out. access_denied is the normal
      // "Cancel" on the consent screen and is not a fault worth alarming anyone about.
      const denied = errParam === "access_denied";
      oauthLog("denied", `error=${errParam}`);
      if (denied) {
        // Cancelling is a choice, not a fault, so it is logged but not recorded
        // as a failure the owner needs to look at.
        return res.status(400).send(oauthFailPageHTML("Sign-in cancelled",
          "You chose not to continue, so nothing was changed on your account."));
      }
      return res.status(400).send(oauthFail("google", errParam,
        "Google could not sign you in",
        "Google reported a problem and did not send us your details. This is usually temporary; please try again."));
    }
    // One-time use. Google can deliver a code only once, so a state is spent the
    // moment it is looked at, whether or not the exchange then succeeds. Without
    // this, a leaked callback URL could be replayed to mint a second session.
    const rec = OAUTH_STATE.get(state);
    if (state && rec) OAUTH_STATE.delete(state);
    if (!state) {
      return res.status(400).send(oauthFail("callback", "no state param",
        "Sign-in link was incomplete", "This link is missing its security check. Please start again from the shop or your account page."));
    }
    if (!rec) {
      // The usual cause: the service restarted between the click and the return,
      // because the pending state lives in memory only.
      return res.status(400).send(oauthFail("callback", `state not recognised (expired or service restarted): ${state.slice(0, 8)}`,
        "That sign-in link has expired", "For your security we only keep a sign-in link open for 10 minutes, and it is cancelled if the site restarts. Please start again."));
    }
    if (Date.now() > rec.exp) {
      return res.status(400).send(oauthFail("callback", `state expired: ${state.slice(0, 8)}`,
        "That sign-in link has expired", "For your security we only keep a sign-in link open for 10 minutes. Please start again."));
    }
    if (!code) {
      return res.status(400).send(oauthFail("callback", `no code returned for state ${state.slice(0, 8)}`,
        "Google did not send an authorisation code", "Google accepted you but returned nothing we can use. Please try again."));
    }
    const redirectUri = googleRedirectUri();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(()=>({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      const why = String(tokenData.error_description || tokenData.error || `http ${tokenRes.status}`);
      return res.status(400).send(oauthFail("token exchange", why.slice(0, 160),
        "Google would not complete the sign-in",
        `Google said: ${why.slice(0, 160)}. This is not something you have done wrong; please try again in a moment.`));
    }
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const info = await infoRes.json().catch(()=>({}));
    if (!infoRes.ok || !info.email) {
      const why = String(info.error_description || info.error || `http ${infoRes.status}`);
      return res.status(400).send(oauthFail("userinfo", why.slice(0, 120),
        "Google did not share your email address",
        `We need your email to create your account, and Google did not release it (${why.slice(0, 120)}). Please check that your Google account allows sign-in with third-party apps, then try again.`));
    }
    oauthLog("verified", `google account accepted for ${String(info.email).toLowerCase().slice(0, 3)}***`);
    const email = String(info.email).toLowerCase().trim();
    const name = String(info.name || email.split("@")[0] || "User").trim().slice(0,60);
    const googleId = String(info.id || "");
    let users = loadUsers();
    let user = users.find(u => (u.email && u.email.toLowerCase()===email) || (u.googleId && u.googleId===googleId));
    if (!user) {
      const salt = crypto.randomBytes(12).toString("hex");
      const fakePass = crypto.randomBytes(12).toString("hex");
      user = { id: `U${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`, name, email, googleId, phone: "", salt, passHash: hashPass(salt, fakePass), wallet: 0, created: new Date().toISOString(), lastLogin: null, hasPassword: false };
      users.push(user);
      saveUsers(users);
      activity("auth", `${name} (${email}) created account via Google`);
    } else {
      if (!user.googleId) user.googleId = googleId;
      if (!user.email) user.email = email;
      saveUsers(users);
      activity("auth", `${user.name} (${email}) signed in via Google`);
    }
    // refresh after save
    users = loadUsers();
    user = users.find(u => u.id === user.id) || users.find(u => u.email && u.email.toLowerCase()===email);
    user.lastLogin = new Date().toISOString();
    saveUsers(users);
    const token = crypto.randomBytes(24).toString("hex");
    rememberSession(token, { id: user.id, exp: Date.now() + USESSION_TTL });
    res.cookie(UCOOKIE, token, userCookieOpts(req));
    // The success case used to be invisible too, so a customer who was signed in
    // properly and a customer who bounced back out looked identical from outside.
    oauthLog("signed in", `user=${user.id} via=${user.googleId ? "google" : "existing-account"} -> ${rec.next}`);
    /* The session itself is stored in memory (uSessions), so it dies on every
       service restart even though the cookie lives for 30 days. That is the most
       likely reason a customer who was definitely signed in appears logged out a
       moment later, so the cookie attributes are logged once here: if a customer
       says it signed them out and the cookie is there in the log, the session was
       lost in memory rather than rejected by the browser. */
    /* The Set-Cookie on THIS response cannot be relied on: the Cloudflare Worker
       answers the callback and does not pass the origin's headers through, so the
       cookie is created here but never reaches the browser. The session is instead
       established by a single-use ticket that the account page redeems on
       /api/auth/exchange, a path the Worker does not match. The cookie is still
       set here as well, so this flow keeps working on its own if the Worker is ever
       removed, and setting it twice is harmless. */
    const ticket = issueExchangeTicket(user.id);
    redeemAuthTicket(ticket, req, res);
    const back = new URL(rec.next, PUBLIC_BASE || "https://bundles.example.com");
    back.searchParams.set("xchg", ticket);
    const ticketTarget = escapeAttr(back.pathname + back.search);
    /* A real link as well as the meta refresh, so sign-in still completes if either
       mechanism is blocked. Both lead to the ticket redemption. */
    return res.status(200).type("html").set("Cache-Control", "no-store").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${ticketTarget}">
<title>Signed in</title><link rel="stylesheet" href="/css/style.css?v=${STYLE_V}"></head>
<body class="oauth-page"><main class="oauth-card">
<h1>You are signed in</h1>
<p>Taking you to your account now.</p>
<p class="oauth-actions"><a class="btn btn-primary" href="${ticketTarget}">Go to my account</a>
<a class="btn btn-ghost" href="/">Back to the shop</a></p>
</main></body></html>`);
  } catch (e) {
    console.error("[google auth] EXCEPTION", e && e.stack ? e.stack : e);
    oauthFail("exception", String(e && e.message ? e.message : e).slice(0, 160), "Sign-in did not finish",
      "Something went wrong on our side. Nothing was charged and your account was not changed. Please try again.");
    return res.status(500).send(oauthFailPageHTML("Sign-in did not finish",
      "Something went wrong on our side. Nothing was charged and your account was not changed. Please try again."));
  }
};
/* The live callback, outside the Cloudflare Worker interception. */
app.get(GOOGLE_CALLBACK_PATH, googleCallbackHandler);
/* Kept so an OAuth client still authorised against the old /api path keeps working
   instead of failing with redirect_uri_mismatch. */
app.get("/api/auth/google/callback", googleCallbackHandler);

/* ---------- WhatsApp Cloud API webhook: verify + delivery receipts ---------- */
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && WA_VERIFY_TOKEN && safeEqual(token, WA_VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/api/whatsapp/webhook", (req, res) => {
  if (!WA_APP_SECRET) {
    // No app secret yet (still in test mode): accept so Meta's setup check
    // succeeds, but never trust the payload.
    return msgMockOn() ? res.sendStatus(200) : res.status(401).json({ error: "WHATSAPP_APP_SECRET not set, cannot verify webhook." });
  }
  const expected = `sha256=${crypto.createHmac("sha256", WA_APP_SECRET).update(req.rawBody || "").digest("hex")}`;
  if (!safeEqual(String(req.get("x-hub-signature-256") || ""), expected)) return res.status(401).end();
  try {
    for (const entry of (req.body && req.body.entry) || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        for (const st of v.statuses || []) {
          activity("whatsapp", `${st.status} → ${st.recipient_id || "?"} (msg ${String(st.id || "").slice(-8)})`);
        }
        for (const m of v.messages || []) {
          const text = m.text && m.text.body ? m.text.body : m.type || "message";
          activity("whatsapp", `inbound from ${m.from || "?"}: ${String(text).slice(0, 80)}`);
        }
      }
    }
  } catch (_) {}
  res.sendStatus(200);
});

app.get("/api/admin/messaging", requireAdmin, (req, res) => {
  res.json({
    channel: msgChannel(),
    label: MSG_CHANNEL_LABEL[msgChannel()] || "your phone",
    whatsapp: {
      on: waOn(),
      apiVersion: WA_VER,
      template: WA_OTP_TEMPLATE || null,
      language: WA_OTP_LANG,
      appSecret: Boolean(WA_APP_SECRET),
      verifyToken: Boolean(WA_VERIFY_TOKEN),
      phoneId: WA_PHONE_ID ? `${WA_PHONE_ID.slice(0, 4)}…${WA_PHONE_ID.slice(-3)}` : null,
    },
    sms: { arkesel: Boolean(ARKSEL_KEY), africastalking: Boolean(AT_USER && AT_KEY) },
    webhookUrl: `${PUBLIC_BASE || "https://bundles.example.com"}/api/whatsapp/webhook`,
  });
});

app.post("/api/admin/test-otp", requireAdmin, rateLimit(LIMIT_WINDOW, 6), async (req, res) => {
  const raw = String((req.body && req.body.phone) || cfg("CONTACT_PHONE", "")).replace(/\D/g, "");
  const phone = raw.replace(/^233/, "0");
  if (!/^0[245][0-9]{8}$/.test(phone)) return res.status(400).json({ error: "Enter a valid Ghanaian mobile number (e.g. 024XXXXXXX)." });
  const code = genOtp();
  const sent = await sendOtp(phone, code);
  if (!sent.ok) {
    activity("otp-test", `test send FAILED to ${phone}: ${sent.error}`);
    return res.status(502).json({ error: sent.error, channel: sent.channel });
  }
  activity("otp-test", `test code sent to ${phone} via ${sent.channel}${sent.template ? ` (${sent.template})` : ""}`);
  res.json({
    ok: true,
    channel: sent.channel,
    to: sent.to || phone,
    template: sent.template || null,
    message: sent.channel === "mock" ? "Test mode. No SMS/WhatsApp sent. Server log holds the code." : `Test message sent to ${sent.to || phone}.`,
    mockCode: sent.channel === "mock" ? code : undefined,
  });
});

/* ---------- customer contact number (Google proves identity; phone is contact detail) ---------- */
app.put("/api/auth/phone", requireUser, rateLimit(LIMIT_WINDOW, 10), (req, res) => {
  const raw = String((req.body && req.body.phone) || "").replace(/\D/g, "");
  const phone = raw.replace(/^233/, "0");
  if (!/^0[245][0-9]{8}$/.test(phone)) return res.status(400).json({ error: "Enter a valid Ghanaian mobile number (e.g. 024XXXXXXX)." });
  const users = loadUsers();
  const me = users.find((u) => u.id === req.user.id);
  if (!me) return res.status(401).json({ error: "Session ended. Sign in again." });
  if (me.phone === phone) return res.json(userPublic(me));
  if (users.some((u) => u.id !== me.id && u.phone === phone)) return res.status(409).json({ error: "That number is already on another account." });
  me.phone = phone;
  saveUsers(users);
  activity("auth", `${me.name} saved contact number ${phone}`);
  res.json(userPublic(me));
});

/* ---------- customer sign-up and sign-in (email + password) ----------
   Google stays the first choice, but it is a single external dependency: if it is
   down, misconfigured, blocked in the customer's browser or simply refused, every
   customer is locked out of member prices, the wallet and order history. This is a
   self-contained fallback that needs no third party at all.

   Details that matter:
   - the password is never stored, only a scrypt hash with a per-user salt
   - the comparison is timing-safe, and failures say the same thing whether the
     account exists or not, so the form cannot be used to discover who is a customer
   - a successful sign-in is not treated as a failed guess: the per-IP budget is
     refunded on success, exactly as the admin login does, so a real customer on a
     shared network is not locked out by their own successful use
   - failed attempts are also counted per account, so one attacker cannot lock a
     known customer out by guessing at them from many addresses
   - an account is found by email OR phone, and a Google sign-in for the same email
     lands on the same account rather than creating a second one */
const ACC_FAIL_MAX = 8;
const ACC_FAIL_WINDOW = 15 * 60 * 1000;
const accFails = new Map(); // account key -> [timestamps of wrong passwords]
const accRecent = (key) => (accFails.get(key) || []).filter((t) => t > Date.now() - ACC_FAIL_WINDOW);
const accLocked = (key) => accRecent(key).length >= ACC_FAIL_MAX;
function accFail(key) {
  const list = accRecent(key);
  list.push(Date.now());
  accFails.set(key, list);
}
const accReset = (key) => accFails.delete(key);
/* find by email or phone, case-insensitively, so "Name@Gmail.com" and a leading
   or trailing space still reach the same customer */
const findByEmailOrPhone = (email, phone) => {
  const e = normEmail(email), p = normPhone(phone);
  return loadUsers().find((u) => (e && normEmail(u.email) === e) || (p && normPhone(u.phone) === p)) || null;
};

/* Registration is capped per IP, but generously, and a success is refunded.
   Ghanaian mobile networks put many customers behind one shared address, so a
   tight budget meant real customers on the same connection locked each other out
   of the exact feature that exists so they are not stuck. Creating an account
   grants nothing and requires no secret, so unlike a sign-in guess it is not the
   thing an attacker is after, and refunding a success is safe. */
app.post("/api/auth/register", rateLimit(LIMIT_WINDOW, 12, { refundOnSuccess: true }), (req, res) => {
  const b = req.body || {};
  const name = String(b.name == null ? "" : b.name).trim().replace(/\s+/g, " ").slice(0, 60);
  const emailErr = emailProblem(b.email);
  if (emailErr) return res.status(400).json({ error: emailErr });
    const passErr = passwordProblem(b.password);
    if (passErr) return res.status(400).json({ error: passErr });
    if (!name) return res.status(400).json({ error: "Enter your name." });
    // The phone is optional, but if one is typed it must be a real number: an
    // unvalidated value ends up on the customer's top-ups and orders, and the
    // owner relies on it to reach them. This check was written and then not
    // called, so "123" was being accepted and stored.
    if (b.phone != null && String(b.phone).trim() !== "") {
      const phErr = phoneProblem(b.phone);
      if (phErr) return res.status(400).json({ error: phErr });
    }

    let users = loadUsers();
  const email = normEmail(b.email);
  if (users.some((u) => normEmail(u.email) === email)) {
    // Not a leak: the customer is being told about their own address, and the
    // alternative is silently failing on a duplicate they cannot diagnose.
    return res.status(409).json({ error: "An account already uses that email. Sign in instead." });
  }
  const phone = normPhone(b.phone);
  if (phone && users.some((u) => normPhone(u.phone) === phone)) {
    return res.status(409).json({ error: "An account already uses that number. Sign in instead." });
  }
  const salt = newSalt();
  const user = {
    id: publicId(), name, email, phone,
    salt, passHash: hashPassword(b.password, salt), passAlgo: "scrypt",
    wallet: 0, created: new Date().toISOString(), lastLogin: new Date().toISOString(),
    hasPassword: true,
  };
  users.push(user);
  saveUsers(users);
  activity("auth", `${name} (${email}) created an account with a password`);
  const token = crypto.randomBytes(24).toString("hex");
  rememberSession(token, { id: user.id, exp: Date.now() + USESSION_TTL });
  res.cookie(UCOOKIE, token, userCookieOpts(req));
  res.json({ ok: true, user: userPublic(user) });
});

app.post("/api/auth/login", rateLimit(LIMIT_WINDOW, 10, { refundOnSuccess: true }), (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  const phone = normPhone(b.phone);
  const ident = email || phone;
  if (!ident || typeof b.password !== "string" || !b.password) {
    return res.status(400).json({ error: "Enter your email or number and your password." });
  }
  const user = findByEmailOrPhone(email, phone);
  const key = ident;
  if (accLocked(key)) {
    return res.status(429).json({ error: "Too many failed attempts for this account. Please try again in 15 minutes." });
  }
  if (!user || !user.hasPassword || !verifyPassword(user, b.password)) {
    accFail(key);
    // The same sentence whether the account is unknown or the password is wrong,
    // so this cannot be used to find out who has an account.
    return res.status(401).json({ error: "Email or password is not correct." });
  }
    accReset(key);
    // A legacy account (hashed with plain sha256) is silently upgraded to scrypt
    // now that we have the plaintext, and the old hash is replaced.
    const users = loadUsers();
    const stored = users.find((u) => u.id === user.id);
    if (!stored) return res.status(401).json({ error: "Email or password is not correct." });
    if (!stored.passAlgo) {
      const salt = newSalt();
      stored.salt = salt;
      stored.passHash = hashPassword(b.password, salt);
      stored.passAlgo = "scrypt";
    }
    stored.lastLogin = new Date().toISOString();
    saveUsers(users);
    activity("auth", `${stored.name} (${stored.email || stored.phone}) signed in with a password`);
    const token = crypto.randomBytes(24).toString("hex");
    rememberSession(token, { id: stored.id, exp: Date.now() + USESSION_TTL });
    res.cookie(UCOOKIE, token, userCookieOpts(req));
    res.json({ ok: true, user: userPublic(stored) });
});

/* Does an account exist? Answers only whether a password can be set, so it is safe
   to show on the sign-up form: it reveals nothing about wallets or orders. */
app.post("/api/auth/password-exists", rateLimit(LIMIT_WINDOW, 20), (req, res) => {
  const b = req.body || {};
  const user = findByEmailOrPhone(b.email, b.phone);
  res.json({ exists: Boolean(user), hasPassword: Boolean(user && user.hasPassword) });
});

/* Adds a password to an account that has none (a Google customer who wants to be
   able to sign in without Google). Requires the current password when the account
   already has one, so it cannot be used to take over a Google-only account. */
app.post("/api/auth/set-password", requireUser, rateLimit(LIMIT_WINDOW, 5), (req, res) => {
  const b = req.body || {};
  const passErr = passwordProblem(b.password);
  if (passErr) return res.status(400).json({ error: passErr });
  let users = loadUsers();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Account not found." });
  if (user.hasPassword) {
    if (!verifyPassword(user, b.current || "")) {
      return res.status(401).json({ error: "Your current password is not correct." });
    }
  }
  const salt = newSalt();
  user.salt = salt;
  user.passHash = hashPassword(b.password, salt);
  user.passAlgo = "scrypt";
  user.hasPassword = true;
  saveUsers(users);
  activity("auth", `${user.name} set a password on their account`);
  res.json({ ok: true });
});

/* ---------- retired auth methods (kept so old clients get a clear answer) ---------- */
const GONE = (req, res) => res.status(410).json({ error: "This sign-in method is retired. Use Google or your email and password." });
app.post("/api/auth/request-otp", GONE);
app.post("/api/auth/verify-otp", GONE);

/* ---------- wallet top-up via Paystack (auto-credit on verified payment) ---------- */
/* Limits are owner-controlled from the admin (Top-ups tab) and stored in
   data/topup.json, so they can be changed at any time without a deploy. */
const TOPUP_FILE = path.join(__dirname, "..", "data", "topup.json");
const TOPUP_MAX = 10000;
const TOPUP_MIN = 5;
const TOPUP_DEFAULT = { min: 50, max: 10000, chips: [50, 100, 200, 500] };

function topupSettings() {
  const raw = loadJson(TOPUP_FILE, {});
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const min = clamp(raw.min, 1, 100000, TOPUP_DEFAULT.min);
  const max = clamp(raw.max, min, 100000, TOPUP_DEFAULT.max);
  const chips = Array.isArray(raw.chips)
    ? raw.chips.map((c) => Number(c)).filter((c) => Number.isFinite(c) && c >= min && c <= max).slice(0, 6)
    : TOPUP_DEFAULT.chips.filter((c) => c >= min && c <= max);
  return {
    min, max,
    chips: chips.length ? chips.slice().sort((a, b) => a - b) : [min],
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}
// Public shape: no owner name, no timestamp, nothing internal.
const publicTopup = (s) => ({ min: s.min, max: s.max, chips: s.chips });
const topupRangeError = (s) => `Enter an amount between GHS ${s.min.toLocaleString()} and GHS ${s.max.toLocaleString()}.`;

/* Paystack can disable a merchant account at any time. Remember it briefly so we
   fail fast with an honest message instead of hammering a disabled account. */
let paystackDownUntil = 0;
let paystackDownWhy = "";

app.post("/api/wallet/topup/paystack", requireUser, rateLimit(LIMIT_WINDOW, 10), async (req, res) => {
  if (!paystack.initialized()) return res.status(503).json({ error: "Card/MoMo payment is not available right now. Use the request option instead." });
  if (Date.now() < paystackDownUntil) return res.status(503).json({ error: "Card payment is temporarily unavailable. Please use Request top-up or message us on WhatsApp." });
  const amount = readAmount(req.body && req.body.amount);
  const ts = topupSettings();
  if (amount === null || amount < ts.min || amount > ts.max)
    return res.status(400).json({ error: topupRangeError(ts) });
  const users = loadUsers();
  const me = users.find((u) => u.id === req.user.id);
  if (!me) return res.status(401).json({ error: "Session ended. Sign in again." });

  const topups = loadTopups();
  // Never leave a pile of unpaid attempts behind, and never allow a card-testing loop.
  const mine = topups.filter((t) => t.userId === me.id);
  if (mine.filter((t) => t.status === "awaiting_payment").length >= 3)
    return res.status(429).json({ error: "You have 3 card payments waiting. Finish or cancel one first." });
  if (mine.filter((t) => t.status === "awaiting_payment").slice(0, 12).reduce((a, t) => a + (Number(t.amount) || 0), 0) + amount > 20000)
    return res.status(429).json({ error: "Too much waiting to be paid. Contact support if one of these was already charged." });

  // Reference is our own and the amount is PINNED here. The webhook only ever
  // credits this exact amount after Paystack confirms it - a tampered client
  // amount or a forged webhook cannot create credit.
  const ref = `TP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  topups.unshift({
    id: ref, userId: me.id, name: me.name, phone: me.phone, amount,
    status: "awaiting_payment", method: "paystack",
    note: "", created: new Date().toISOString(), handledAt: null,
    paystackRef: ref, credited: false, walletAfter: null,
  });
  saveTopups(topups);
  try {
    const init = await paystack.initializeOrder({
      amount, orderId: ref, reference: ref,
      email: me.email || `${String(me.phone || "customer").replace(/\D/g, "")}@payments.example.com`,
      callbackPath: "/account",
    });
    activity("topup", `${me.name} started a GHS ${amount.toFixed(2)} card payment (${ref})`);
    res.json({ ok: true, id: ref, amount, url: init.authorization_url, reference: init.reference });
  } catch (e) {
    const list = loadTopups();
    const t = list.find((x) => x.id === ref);
    if (t) { t.status = "failed"; t.error = String(e.message).slice(0, 200); t.handledAt = new Date().toISOString(); saveTopups(list); }
    const why = String(e.message || "");
    activity("topup", `card payment FAILED to start for ${me.name} (${ref}): ${why.slice(0, 120)}`);
    if (/inactive|disabled_merchant|not active/i.test(why)) {
      paystackDownUntil = Date.now() + 15 * 60 * 1000;
      paystackDownWhy = why.slice(0, 160);
      alertAdmin("security", `Paystack refused card payments: ${paystackDownWhy}. Customers are being told to use Request top-up. Action needed: contact support@paystack.com to reactivate the merchant account.`);
    } else {
      alertAdmin("topup", `card payment could not start for ${me.name} (${ref}): ${why.slice(0, 140)}`);
    }
    res.status(502).json({ error: "Card payment is unavailable right now. Please use Request top-up, or message us on WhatsApp and we'll add it for you." });
  }
});

/* ---------- wallet: top-up requests ---------- */
/* Strict on purpose: only a real finite number is accepted. Without this,
   Number([50]) and Number(true) are valid amounts by coercion. */
function readAmount(v) {
  if (typeof v === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim())) v = Number(v.trim());
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

app.post("/api/wallet/topup", requireUser, rateLimit(LIMIT_WINDOW, 10), (req, res) => {
  const amount = readAmount(req.body && req.body.amount);
  const ts = topupSettings();
  if (amount === null || amount < ts.min || amount > ts.max)
    return res.status(400).json({ error: topupRangeError(ts) });
  const users = loadUsers();
  const me = users.find((u) => u.id === req.user.id);
  if (!me) return res.status(401).json({ error: "Session ended. Sign in again." });
  const topups = loadTopups();
  if (topups.filter((t) => t.userId === me.id && t.status === "pending").length >= 3)
    return res.status(429).json({ error: "You already have pending top-up requests. Wait for them to be processed." });
  const ref = `TP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  topups.unshift({
    id: ref, userId: me.id, name: me.name, phone: me.phone, amount,
    status: "pending", note: cfg("DEFAULT_PAY_NOTE", ""), created: new Date().toISOString(), handledAt: null,
  });
  saveTopups(topups);
  activity("topup", `${me.name} requested GHS ${amount.toFixed(2)} credit (${ref})`);
  res.json({ ok: true, id: ref, amount, note: cfg("DEFAULT_PAY_NOTE", ""), balance: me.wallet });
});

app.get("/api/wallet/topups", requireUser, (req, res) => {
  const list = loadTopups()
    .filter((t) => t.userId === req.user.id)
    .slice(0, 30)
    .map((t) => ({ id: t.id, amount: t.amount, status: t.status, created: t.created }));
  res.json(list);
});

/* ---------- wallet: purchase with account balance ---------- */
app.post("/api/wallet/order", requireUser, rateLimit(LIMIT_WINDOW, ORDER_MAX), async (req, res) => {
  try {
    const { planId, phone, email } = req.body || {};
    if (!requireTermsAgreed(req.body)) return res.status(400).json({ error: "Please tick the box agreeing to the terms before you pay.", code: "terms_not_agreed" });
    const digits = String(phone || "").replace(/\D/g, "");
    if (!planId) return res.status(400).json({ error: "Please choose a bundle." });
    if (!/^[0-9]{9,13}$/.test(digits)) return res.status(400).json({ error: "Enter a valid beneficiary number." });
    if (isBlocked(digits)) return res.status(403).json({ error: "This number cannot buy data. Please contact us on WhatsApp.", code: "number_blocked" });
    if (email !== undefined && email !== "" && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(String(email).trim()))
      return res.status(400).json({ error: "Enter a valid email (optional)." });

    const products = await idatagh.listProducts();
    const plan = products.find((p) => String(p.id) === String(planId));
    if (!plan) return res.status(404).json({ error: "Selected bundle not found." });
    const sell = priceFor(plan, true).price;
    // Same supplier rule as the storefront: one open order per number at a time,
    // or the supplier rejects the second and gives no refund.
    const walletClash = recentOrderForNumber(digits, SAME_NUMBER_WINDOW_MS);
    if (walletClash) {
      return res.status(409).json({
        error: `There is already an order for ${digits} from ${new Date(walletClash.created).toLocaleString()}. A second order for the same number at the same time can get stuck with no refund. Please wait for it to complete.`,
        code: "same_number_too_soon", orderId: walletClash.id,
      });
    }

    const users = loadUsers();
    const me = users.find((u) => u.id === req.user.id);
    if (!me) return res.status(401).json({ error: "Session ended. Sign in again." });
    if (me.wallet < sell) return res.status(400).json({ error: "Insufficient balance. Add credit to your wallet first.", wallet: me.wallet });
    const availability = await supplierPurchaseGuard(plan.cost);
    if (!availability.ok) return res.status(availability.status).json({ error: availability.error, outOfStock: Boolean(availability.outOfStock) });

    me.wallet = Math.round((me.wallet - sell) * 100) / 100;
    saveUsers(users);

    const order = newOrder();
    order.userId = me.id;
    order.source = "wallet";
    order.planName = plan.name;
    order.planId = String(plan.id);
    order.network = plan.network;
    order.phone = digits;
    order.email = email ? String(email).trim().slice(0, 254) : null;
    order.cost = plan.cost;
    order.sell = sell;
    order.currency = CURRENCY;
    order.reference = crypto.randomBytes(10).toString("hex").slice(0, 12);
    order.status = "processing";
    const orders = loadOrders();
    orders.push(order);
    creditReferralOnFirstPurchase(me.id);
    saveOrders(orders);

      /* MANUAL APPROVAL. The wallet is already debited, so the customer has paid,
         but the bundle is NOT sent to the supplier. The owner sends it by hand. */
      order.status = "paid";
      order.awaitingApproval = true;
      order.providerRef = null;
      order.sendAttempts = 0;
      order.error = "";
      order.verifiedAt = new Date().toISOString();
      saveOrders(orders);
      activity("order", `${me.name} bought ${order.planName} (${order.network}) for ${CURRENCY} ${sell.toFixed(2)}, ${order.id}. Paid and waiting for owner approval - not sent to the supplier.`);
      alertAdmin("topup", `Wallet order paid by ${me.name}: GHS ${sell.toFixed(2)}, ${order.planName} for ${order.phone}, order ${order.id}. Waiting for you to press Process. Nothing has been sent to the supplier.`, `awaiting-approval:${order.id}`);
    saveOrders(orders);
    res.json({ ok: true, order: publicOrder(order), balance: me.wallet, awaitingApproval: true, error: null });
  } catch (e) {
    res.status(500).json({ error: "We could not place this order right now. Please try again shortly." });
  }
});

app.get("/api/account/orders", requireUser, (req, res) => {
  const me = loadUsers().find((u) => u.id === req.user.id);
  const myPhone = String((me && me.phone) || "").replace(/\D/g, "");
  const list = loadOrders()
    // Include older guest/manual orders that used this account's number, so history
    // bought before the account existed is not lost.
    .filter((o) => o.userId === req.user.id || (!o.userId && myPhone && String(o.phone || "").replace(/\D/g, "") === myPhone))
    .slice(-50).reverse()
    .map((o) => ({
      id: o.id, trackCode: o.trackCode || null, created: o.created, planName: o.planName, network: o.network,
      sell: o.sell, currency: o.currency, status: o.status, reference: o.reference,
      progress: orderProgress(o),
    }));
  res.json(list);
});

/* ---------- admin: customers, top-ups, logs ---------- */
app.get("/api/admin/users", requireAdmin, rateLimit(LIMIT_WINDOW, 40), (req, res) => {
  const users = loadUsers().slice(-100).reverse().map((u) => ({
    id: u.id, name: u.name, phone: u.phone, wallet: u.wallet, created: u.created,
  }));
  res.json({ users });
});

app.get("/api/admin/topups", requireAdmin, rateLimit(LIMIT_WINDOW, 40), (req, res) => {
  const list = loadTopups().slice(0, 100).map((t) => ({
    id: t.id, name: t.name, phone: t.phone, amount: t.amount, status: t.status,
    created: t.created, handledAt: t.handledAt, note: t.note,
  }));
  res.json({ topups: list, settings: topupSettings() });
});

/* ---------- top-up limits (owner-controlled) ---------- */
app.get("/api/admin/topup", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  res.json({ settings: topupSettings() });
});

app.put("/api/admin/topup", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  const b = req.body || {};
  const cur = topupSettings();
  const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };
  const min = Math.round(Math.min(Math.max(num(b.min, cur.min), 1), 100000) * 100) / 100;
  const max = Math.round(Math.min(Math.max(num(b.max, cur.max), min), 100000) * 100) / 100;
  const rawChips = Array.isArray(b.chips)
    ? b.chips
    : String(b.chips == null ? "" : b.chips).split(/[,\s]+/).filter(Boolean);
  const chips = rawChips
    .map((c) => Math.round(Number(c) * 100) / 100)
    .filter((c) => Number.isFinite(c) && c >= min && c <= max)
    .filter((c, i, a) => a.indexOf(c) === i)
    .slice(0, 6)
    .sort((x, y) => x - y);
  const next = { min, max, chips: chips.length ? chips : [min], updatedAt: new Date().toISOString(), updatedBy: req.admin.user };
  saveJson(TOPUP_FILE, next);
  const s = topupSettings();
  activity("topup", `Top-up limits updated: GHS ${s.min} to GHS ${s.max}, quick amounts ${s.chips.join(", ")}`);
  res.json({ ok: true, settings: s });
});

app.post("/api/admin/topups/:id", requireAdmin, rateLimit(LIMIT_WINDOW, 40), (req, res) => {
  const action = String((req.body && req.body.action) || "");
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  const topups = loadTopups();
  const t = topups.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Top-up not found" });
  /* The owner may clear an abandoned card top-up. This only removes a dead row so
     it stops counting against the customer's cap; it never credits anything, and
     it is refused once the top-up is actually paid, so it can never be used to
     dodge a real credit. */
  if (t.status === "awaiting_payment" && !t.credited) {
    t.status = "cancelled";
    t.error = "cleared by owner, card payment never completed";
    t.handledAt = new Date().toISOString();
    saveTopups(topups);
    activity("topup", `owner cleared an abandoned card top-up (${t.id}, GHS ${t.amount.toFixed(2)}, ${t.name})`);
    return res.json({ ok: true, status: t.status });
  }
  if (t.status !== "pending") return res.status(409).json({ error: "Already processed" });

  if (action === "reject") {
    t.status = "rejected";
    t.handledAt = new Date().toISOString();
    saveTopups(topups);
    activity("topup", `${t.name} (${t.phone}) top-up rejected: GHS ${t.amount.toFixed(2)} (${t.id})`);
    return res.json({ ok: true, status: t.status });
  }

  /* Approve. Reuse the one credit path, so a hand approval cannot skip a check
     the automatic one performs. It used to set status=paid and then credit a
     wallet only `if (u)`, which reported APPROVED for a customer who received
     nothing. Now a missing account is an explicit failure, not a silent success. */
  const r = creditTopupOnce(topups, t);
  if (!r.ok) {
    saveTopups(topups);
    alertAdmin("topup", `Top-up ${t.id} (GHS ${t.amount.toFixed(2)}, ${t.name}) was NOT approved: ${r.error} The customer has paid and has no credit.`, `topup-noacct:${t.id}`);
    return res.status(409).json({ error: r.error });
  }
  saveTopups(topups);
  activity("topup", `${t.name} (${t.phone}) top-up approved by owner: GHS ${t.amount.toFixed(2)} (${t.id}). Wallet now GHS ${r.user.wallet.toFixed(2)}`);
  res.json({ ok: true, status: t.status, wallet: r.user.wallet });
});

app.get("/api/admin/logs", requireAdmin, rateLimit(LIMIT_WINDOW, 40), (req, res) => {
  const limit = Math.min(Number((req.query && req.query.limit) || 200), 500);
  res.json({ logs: loadActivity().slice(0, limit) });
});

app.get("/api/admin/alerts", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  const all = loadAlerts();
  res.json({
    unseen: all.filter((a) => !a.seen).length,
    security: all.filter((a) => a.type === "security").length,
    alerts: all.slice(0, 50),
  });
});

app.post("/api/admin/alerts/seen", requireAdmin, (req, res) => {
  const list = loadAlerts();
  for (const a of list) a.seen = true;
  saveJson(ALERTS_FILE, list);
  res.json({ ok: true, alerts: list.slice(0, 50) });
});

/* ---------- network status banner (admin) ---------- */
app.get("/api/network-status", (req, res) => {
  res.json(loadJson(STATUS_FILE, { mtn: "normal", telecel: "normal", airteltigo: "normal", message: "" }));
});
app.post("/api/admin/network-status", requireAdmin, (req, res) => {
  const allowed = ["normal", "delayed", "down"];
  const cur = loadJson(STATUS_FILE, { mtn: "normal", telecel: "normal", airteltigo: "normal", message: "" });
  for (const k of ["mtn", "telecel", "airteltigo"]) {
    const v = String((req.body && req.body[k]) || "").toLowerCase();
    if (v && allowed.includes(v)) cur[k] = v;
  }
  if (req.body && typeof req.body.message === "string") cur.message = String(req.body.message).slice(0, 200);
  saveJson(STATUS_FILE, cur);
  res.json(cur);
});

/* ---------- buyer notice board (admin posts, everyone sees) ---------- */
const NOTICE_LEVELS = ["info", "warning", "critical"];
const NOTICE_DEFAULT = { active: false, level: "info", title: "", message: "", updatedAt: null };

function cleanText(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, "")          // strip markup at write time, not only at render
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
// Buyers only ever see these three fields: no author, no IP, no admin detail.
const publicNotice = (n) => ({
  active: !!n.active,
  level: NOTICE_LEVELS.includes(n.level) ? n.level : "info",
  title: cleanText(n.title, 80),
  message: cleanText(n.message, 300),
  updatedAt: n.updatedAt || null,
});
const loadNotice = () => publicNotice(loadJson(NOTICE_FILE, NOTICE_DEFAULT));

app.get("/api/notice", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ notice: loadNotice() });
});

app.get("/api/admin/notice", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  res.json({ notice: loadNotice() });
});

// Writes are generous on purpose: this is admin-session-only and is used during
// emergencies, so a worried owner must never be locked out of publishing a notice.
app.post("/api/admin/notice", requireAdmin, rateLimit(LIMIT_WINDOW, 120), (req, res) => {
  const body = req.body || {};
  const next = {
    active: body.active === true,
    level: NOTICE_LEVELS.includes(String(body.level || "").toLowerCase()) ? String(body.level).toLowerCase() : "info",
    title: cleanText(body.title, 80),
    message: cleanText(body.message, 300),
    updatedAt: new Date().toISOString(),
  };
  if (next.active && (!next.title || !next.message)) {
    return res.status(400).json({ error: "Add a title and a message before publishing." });
  }
  saveJson(NOTICE_FILE, next);
  activity("notice", next.active
    ? `Buyer notice published (${next.level}): ${next.title}`
    : "Buyer notice cleared");
  res.json({ ok: true, notice: publicNotice(next) });
});

/* ---------- admin: supplier (iDATA) health ---------- */
const SUPPLIER_LOW = Number(cfg("SUPPLIER_LOW_GHS", "50"));

async function supplierSnapshot() {
  let balance = null;
  let error = null;
  let catalogError = null;
  try {
    const w = await idatagh.walletBalance();
    balance = round2(w.balance);
  } catch (e) {
    error = String(e.message || e).slice(0, 160);
  }
  let products = [];
  try { products = await idatagh.listProducts(); } catch (e) {
    catalogError = String(e.message || e).slice(0, 160);
  }
  const cheapest = products.length ? Math.min(...products.map((p) => Number(p.cost) || Infinity)) : null;
  const ordersLeft = balance !== null && cheapest > 0 ? Math.floor(balance / cheapest) : null;
  return {
    balance,
    error,
    catalogError,
    bundles: products.length,
    cheapestCost: cheapest,
    ordersLeft,
    low: balance !== null && balance < SUPPLIER_LOW,
    threshold: SUPPLIER_LOW,
    checkedAt: new Date().toISOString(),
  };
}

async function supplierPurchaseGuard(cost) {
  if (mockEnabled()) return { ok: true, mock: true };
  const required = Number(cost);
  if (!Number.isFinite(required) || required <= 0) {
    return { ok: false, status: 503, error: "Data is temporarily unavailable. Please try again shortly." };
  }
  let snapshot;
  try { snapshot = await supplierSnapshot(); }
  catch (_) {
    return { ok: false, status: 503, error: "Data is temporarily unavailable. Please try again shortly." };
  }
  if (snapshot.error || snapshot.catalogError || snapshot.balance === null) {
    return { ok: false, status: 503, error: "Data is temporarily unavailable. Please try again shortly." };
  }
  if (Number(snapshot.balance) < required) {
    return { ok: false, status: 409, outOfStock: true, error: "This bundle is temporarily out of stock. Please try again later." };
  }
  return { ok: true, supplier: snapshot };
}

app.get("/api/admin/supplier", requireAdmin, async (req, res) => {
  const s = await supplierSnapshot();
  res.json(s);
});

/* Background supplier watch: warn the owner before a delivery fails because the
   upstream wallet is empty or the API is down. Debounced so it cannot spam. */
let supplierLastAlert = { key: "", at: 0 };
async function supplierHealthCheck() {
  if (mockEnabled()) return;
  let s;
  try { s = await supplierSnapshot(); } catch (_) { return; }
  let key = "";
  let msg = "";
  if (s.error) { key = "err"; msg = `Cannot reach iDATA: ${s.error}. Orders may fail to deliver. Check before accepting more customer money.`; }
  else if (s.catalogError) { key = "catalog"; msg = `iDATA balance is readable, but its bundle catalog failed: ${s.catalogError}. The number of servable orders is unknown.`; }
  else if (s.balance !== null && s.balance <= 0) { key = "zero"; msg = "iDATA balance is GHS 0.00. No customer can be served. Top up immediately or pause selling."; }
  else if (s.low) { key = `low:${Math.floor(s.balance / 5) * 5}`; msg = `iDATA balance is low: GHS ${s.balance.toFixed(2)} (about ${s.ordersLeft} order${s.ordersLeft === 1 ? "" : "s"} left). Top up soon.`; }
  if (!key) { supplierLastAlert.key = ""; return; }
  const now = Date.now();
  if (supplierLastAlert.key === key && now - supplierLastAlert.at < 60 * 60 * 1000) return;
  supplierLastAlert = { key, at: now };
  alertAdmin("supplier", msg, `supplier:${key}`);
}
setInterval(() => { supplierHealthCheck(); }, 15 * 60 * 1000).unref();
setTimeout(() => { supplierHealthCheck(); }, 5000).unref();

app.post("/api/admin/supplier/check", requireAdmin, async (req, res) => {
  const s = await supplierSnapshot();
  if (s.error) {
    alertAdmin("supplier", `Could not reach iDATA: ${s.error}. You may not be able to deliver. Check before accepting money.`);
  } else if (s.catalogError) {
    alertAdmin("supplier", `iDATA balance is readable, but its bundle catalog failed: ${s.catalogError}. The number of servable orders is unknown.`);
  } else if (s.balance !== null && s.balance <= 0) {
    alertAdmin("supplier", `iDATA balance is GHS 0.00. No customer can be served. Top up immediately.`);
  }
  res.json(s);
});

/* ---------- admin: sales reporting ---------- */
app.get("/api/admin/sales", requireAdmin, async (req, res) => {
  const orders = loadOrders();
  // Money actually kept: a refunded order gave the money back, so it is not revenue.
  const isRevenue = (o) => ["paid", "processing", "delivered", "failed"].includes(o.status);
  const paid = orders.filter(isRevenue);
  const delivered = orders.filter((o) => o.status === "delivered");
  const refunded = orders.filter((o) => o.status === "refunded");
  const money = (list, key) => round2(list.reduce((a, o) => a + (Number(o[key]) || 0), 0));
  const period = (list) => {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    return {
      today: money(list.filter((o) => String(o.created) >= day), "sell"),
      month: money(list.filter((o) => String(o.created) >= month), "sell"),
    };
  };
  const byBundle = {};
  for (const o of paid) {
    const key = String(o.planId || o.planName || "unknown");
    if (!byBundle[key]) byBundle[key] = { planId: o.planId, planName: o.planName || "n/a", network: o.network || "n/a", orders: 0, delivered: 0, revenue: 0, cost: 0 };
    const row = byBundle[key];
    row.orders++;
    if (o.status === "delivered") row.delivered++;
    row.revenue = round2(row.revenue + (Number(o.sell) || 0));
    row.cost = round2(row.cost + (Number(o.cost) || 0));
  }
  const bundles = Object.values(byBundle)
    .map((r) => ({ ...r, profit: round2(r.revenue - r.cost) }))
    .sort((a, b) => b.revenue - a.revenue);
  const topUps = loadTopups().filter((t) => t.status === "paid");
  res.json({
    totals: {
      orders: orders.length,
      paidOrders: paid.length,
      delivered: delivered.length,
      refunded: refunded.length,
      revenue: money(paid, "sell"),
      cost: money(paid, "cost"),
      profit: round2(money(paid, "sell") - money(paid, "cost")),
      refundedValue: money(refunded, "sell"),
      walletBalance: loadUsers().reduce((a, u) => a + (Number(u.wallet) || 0), 0),
      topupApproved: round2(topUps.reduce((a, t) => a + (Number(t.amount) || 0), 0)),
    },
    period: { paid: period(paid), delivered: period(delivered) },
    bundles,
    supplier: await supplierSnapshot(),
  });
});

/* ---------- admin pricing control ---------- */
app.get("/api/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const p = loadPricing();
    const products = await idatagh.listProducts();
    const rows = products.map((pl) => {
      const { member, guest, memberInfo } = bothPrices(pl);
      return {
        id: String(pl.id), network: pl.network, name: pl.name, sizeMb: pl.sizeMb,
        cost: round2(pl.cost), member, guest,
        marginPercent: memberInfo.marginPercent, source: memberInfo.source,
        floored: memberInfo.floored,
        override: p.overrides[String(pl.id)] || null,
      };
    });
    res.json({
      settings: p,
      promoLive: promoLive(p.promo),
      promoExpired: Boolean(p.promo.active && p.promo.endsAt && Date.parse(p.promo.endsAt) < Date.now()),
      savePercent: savePercent(),
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: "Could not load pricing: " + e.message });
  }
});

const pricingBody = (body) => {
  const cur = loadPricing();
  const p = { ...cur };
  if (body.markupPercent !== undefined) p.markupPercent = clamp(Number(body.markupPercent) || 0, -90, 1000);
  if (body.guestMarkupPercent !== undefined) p.guestMarkupPercent = clamp(Number(body.guestMarkupPercent) || 0, -90, 1000);
  if (body.minMarginPercent !== undefined) p.minMarginPercent = clamp(Number(body.minMarginPercent) || 0, 0, 1000);
  if (body.promo && typeof body.promo === "object") {
    const pr = body.promo;
    p.promo = {
      active: pr.active !== undefined ? Boolean(pr.active) : cur.promo.active,
      percent: pr.percent !== undefined ? clamp(Number(pr.percent) || 0, 0, 100) : cur.promo.percent,
      networks: Array.isArray(pr.networks) && pr.networks.length ? pr.networks.map((n) => String(n).toLowerCase()) : cur.promo.networks,
      label: pr.label !== undefined ? String(pr.label).slice(0, 60) : cur.promo.label,
      endsAt: pr.endsAt !== undefined ? (pr.endsAt ? String(pr.endsAt) : null) : cur.promo.endsAt,
    };
  }
  return p;
};

app.put("/api/admin/pricing", requireAdmin, (req, res) => {
  res.json(savePricing(pricingBody(req.body || {})));
});

/* Per-plan override: { fixed: number } pins the price, or { mode: "auto" } clears it. */
app.put("/api/admin/pricing/plan/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const p = loadPricing();
  const body = req.body || {};
  if (body.mode === "auto" || body.fixed === null || body.fixed === "") {
    delete p.overrides[id];
  } else {
    const fixed = Number(body.fixed);
    if (!Number.isFinite(fixed) || fixed <= 0) return res.status(400).json({ error: "Enter a price above 0." });
    p.overrides[id] = { mode: "fixed", fixed: round2(fixed), note: String(body.note || "").slice(0, 80), set: new Date().toISOString() };
  }
  savePricing(p);
  res.json(p.overrides[id] || { mode: "auto" });
});

/* ---------- saved numbers (per user) ---------- */
function loadSaved(userId) {
  const all = loadJson(SAVED_NUMS_FILE, {});
  return Array.isArray(all[userId]) ? all[userId] : [];
}
function saveSaved(userId, list) {
  const all = loadJson(SAVED_NUMS_FILE, {});
  all[userId] = list.slice(0, 20);
  saveJson(SAVED_NUMS_FILE, all);
}
app.get("/api/account/saved-numbers", requireUser, (req, res) => {
  res.json(loadSaved(req.user.id));
});
app.post("/api/account/saved-numbers", requireUser, (req, res) => {
  const label = String((req.body && req.body.label) || "").trim().slice(0, 20);
  const phone = String((req.body && req.body.phone) || "").replace(/\D/g, "").replace(/^233/, "0");
  if (!label || !/^0[245][0-9]{8}$/.test(phone)) return res.status(400).json({ error: "Provide a label and a valid Ghanaian number." });
  const list = loadSaved(req.user.id);
  if (list.some((x) => x.phone === phone)) return res.status(409).json({ error: "Number already saved." });
  list.push({ label, phone });
  saveSaved(req.user.id, list);
  res.json(list);
});
app.delete("/api/account/saved-numbers/:phone", requireUser, (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, "").replace(/^233/, "0");
  let list = loadSaved(req.user.id);
  list = list.filter((x) => x.phone !== phone);
  saveSaved(req.user.id, list);
  res.json(list);
});

/* ---------- referrals ---------- */
app.get("/api/account/referral", requireUser, (req, res) => {
  const code = Buffer.from(req.user.id).toString("base64url");
  const base = PUBLIC_BASE || cfg("PUBLIC_BASE_URL", "");
  res.json({ code, link: `${base}?ref=${code}` });
});
app.post("/api/account/claim-referral", requireUser, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (!code) return res.status(400).json({ error: "No referral code." });
  let referrerId;
  try { referrerId = Buffer.from(code, "base64url").toString(); } catch { return res.status(400).json({ error: "Invalid code." }); }
  if (referrerId === req.user.id) return res.status(400).json({ error: "You can't refer yourself." });
  if (!/^U[A-Z0-9]+$/.test(referrerId)) return res.status(400).json({ error: "Invalid code." });
  const refs = loadJson(REFERRALS_FILE, []);
  if (refs.some((r) => r.referred === req.user.id)) return res.status(409).json({ error: "Referral already claimed." });
  const users = loadUsers();
  if (!users.some((u) => u.id === referrerId)) return res.status(404).json({ error: "That referral code is not valid." });
  // Record the relationship only. The bonus is paid when the referred person's
  // FIRST order is actually paid for. Crediting on claim let anyone farm GHS 2
  // per throwaway account with no purchase at all.
  refs.push({ referrer: referrerId, referred: req.user.id, created: new Date().toISOString(), credited: false, creditedAt: null });
  saveJson(REFERRALS_FILE, refs);
  res.json({ ok: true, credited: false, message: "Referral saved. Your GHS 2 is credited after your first payment." });
});

/** Pay out a referral bonus once the referred customer has actually paid. */
function creditReferralOnFirstPurchase(userId) {
  if (!userId) return null;
  const refs = loadJson(REFERRALS_FILE, []);
  const ref = refs.find((r) => r.referred === userId && !r.credited);
  if (!ref) return null;
  const credit = Number(cfg("REFERRAL_CREDIT", "2"));
  if (!(credit > 0)) return null;
  const users = loadUsers();
  const a = users.find((u) => u.id === ref.referrer);
  const b = users.find((u) => u.id === ref.referred);
  if (!b) return null;
  b.wallet = round2(b.wallet + credit);
  if (a) a.wallet = round2(a.wallet + credit);
  saveUsers(users);
  ref.credited = true;
  ref.creditedAt = new Date().toISOString();
  saveJson(REFERRALS_FILE, refs);
  activity("referral", `${b.name} first paid, GHS ${credit} referral bonus to ${b.name}${a ? ` and ${a.name}` : ""}`);
  return { credit, referrer: a ? a.name : null };
}

/* ---------- bulk order ---------- */
app.post("/api/wallet/bulk-order", requireUser, rateLimit(LIMIT_WINDOW, 5), async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 50) return res.status(400).json({ error: "Send 1-50 rows." });
  if (!requireTermsAgreed(req.body)) return res.status(400).json({ error: "Please tick the box agreeing to the terms before you place a bulk order.", code: "terms_not_agreed" });
  // One order per number at a time, the same supplier rule as the storefront, so a
  // duplicate in a bulk list cannot be silently rejected by the network.
  const dupes = validatedDupes(rows);
  if (dupes.length) return res.status(409).json({ error: `These numbers appear more than once in your list: ${dupes.join(", ")}. One order at a time per number, or the network can reject one with no refund.`, code: "same_number_too_soon" });
  /* The batch was only checked against ITSELF. A number could already have an open
     order from an earlier single or bulk purchase, and the supplier rejects a
     second order for the same number in the same period with NO refund - the
     customer is charged for the whole batch and the owner loses a row. Found by
     the independent review of 2026-09-29. Same rule as the storefront, applied
     per row, before any money is taken. */
  const alreadyOpen = [];
  for (const r of rows) {
    const digits = String(r.phone || "").replace(/\D/g, "").replace(/^233/, "0");
    if (!digits) continue;
    if (recentOrderForNumber(digits, SAME_NUMBER_WINDOW_MS)) alreadyOpen.push(digits);
  }
  if (alreadyOpen.length) {
    const list = [...new Set(alreadyOpen)].slice(0, 6).join(", ");
    return res.status(409).json({ error: `These numbers already have an order in progress: ${list}. One order at a time per number, or the network can reject one with no refund.`, code: "same_number_too_soon" });
  }
  const products = await idatagh.listProducts();
  const users = loadUsers();
  const me = users.find((u) => u.id === req.user.id);
  if (!me) return res.status(401).json({ error: "Session ended." });
  let total = 0;
  let supplierTotal = 0;
  const validated = [];
  for (const r of rows) {
    const phone = String(r.phone || "").replace(/\D/g, "").replace(/^233/, "0");
    if (!/^0[245][0-9]{8}$/.test(phone)) { validated.push({ phone: r.phone, error: "invalid number" }); continue; }
    if (isBlocked(phone)) { validated.push({ phone, error: "number blocked" }); continue; }
    const plan = products.find((p) => String(p.id) === String(r.planId));
    if (!plan) { validated.push({ phone, error: "bundle not found" }); continue; }
    const sell = priceFor(plan, true).price;
    total += sell;
    supplierTotal += Number(plan.cost) || 0;
    validated.push({ phone, planId: String(plan.id), planName: plan.name, network: plan.network, sell });
  }
  if (validated.some((v) => v.error)) return res.status(400).json({ error: "Some rows invalid.", rows: validated });
  if (me.wallet < total) return res.status(400).json({ error: `Insufficient balance. Need GHS ${total.toFixed(2)}`, wallet: me.wallet });
  const availability = await supplierPurchaseGuard(supplierTotal);
  if (!availability.ok) return res.status(availability.status).json({ error: availability.error, outOfStock: Boolean(availability.outOfStock) });
  me.wallet = Math.round((me.wallet - total) * 100) / 100;
  saveUsers(users);
  const orders = loadOrders();
  const created = [];
  for (const v of validated) {
    const o = newOrder(); o.userId = me.id; o.source = "wallet"; o.planId = v.planId; o.planName = v.planName; o.network = v.network; o.phone = v.phone; o.cost = products.find((p) => String(p.id) === v.planId).cost; o.sell = v.sell;     o.currency = CURRENCY; o.reference = crypto.randomBytes(10).toString("hex").slice(0, 12); o.status = "paid"; o.termsVersion = TERMS_VERSION; o.termsAcceptedAt = new Date().toISOString();
      /* MANUAL APPROVAL: the wallet is debited, but nothing goes to the supplier
         until the owner approves each row by hand. */
      o.awaitingApproval = true; o.sendAttempts = 0; o.error = ""; o.verifiedAt = new Date().toISOString();
    orders.push(o); created.push(publicOrder(o));
  }
  activity("order", `Bulk order from ${me.name}: ${validated.length} numbers, GHS ${total.toFixed(2)} paid. Waiting for owner approval - nothing sent to the supplier.`);
  alertAdmin("topup", `Bulk order paid by ${me.name}: ${validated.length} numbers, GHS ${total.toFixed(2)}. Waiting for you to approve. Nothing has been sent to the supplier.`, `awaiting-approval-bulk:${me.id}`);
  creditReferralOnFirstPurchase(me.id);
  saveUsers(users); saveOrders(orders);
  res.json({ ok: true, orders: created, balance: me.wallet, total, awaitingApproval: true, refundPending: 0 });
});

/* Admin shell is public; every /api/admin/* route is behind requireAdmin, so the
   login form must be reachable or the owner is locked out of their own panel. */
app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

/* ---------- public API ---------- */
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1y", immutable: true, setHeaders: (res, filePath) => {
  if (/\.html$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  else if (/\.(js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
} }));

app.get("/api/health", (req, res) => res.json({ ok: true, mode: mockEnabled() ? "mock" : "live" }));

app.get("/api/config", (req, res) => {
  const status = loadJson(STATUS_FILE, { mtn: "normal", telecel: "normal", airteltigo: "normal", message: "" });
  const orders = loadOrders();
  const today = new Date().toISOString().slice(0, 10);
  const deliveredToday = orders.filter((o) => o.status === "delivered" && o.created.slice(0, 10) === today).length;
  const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
  const deliveredWeek = orders.filter((o) => o.status === "delivered" && o.created.slice(0,10) >= weekAgo).length;
  const waRaw = cfg("CONTACT_WHATSAPP", "");
  const isPlaceholderWa = !waRaw || waRaw === "233240000000" || waRaw.replace(/\D/g,"").length < 10;
  res.json({
    siteName: SITE_NAME,
    currency: CURRENCY,
    networks: [
      { name: "MTN", color: "#ffcc00", text: "#1a1a1a" },
      { name: "AirtelTigo", color: "#0047AB", text: "#fff" },
      { name: "Telecel", color: "#e30613", text: "#fff" },
    ],
    paystackOn: paystack.initialized(),
    googleOn: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    notifyChannel: msgChannel(),
    notifyLabel: MSG_CHANNEL_LABEL[msgChannel()] || "your phone",
    unpaidEnabled: cfg("DEFAULT_PAY_NOTE", "").length > 0,
    contact: { whatsapp: isPlaceholderWa ? "" : waRaw, email: cfg("CONTACT_EMAIL"), phone: cfg("CONTACT_PHONE", ""), location: cfg("CONTACT_LOCATION", "Accra, Ghana") },
    statusBanner: status,
    notice: loadNotice(),
    topup: publicTopup(topupSettings()),
    deliveredToday, deliveredWeek,
    savePercent: promoLive(loadPricing().promo) ? 0 : savePercent(),
  });
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await idatagh.listProducts();
    const enriched = products.map((p) => {
      const { member: mp, guest: gp } = bothPrices(p);
      const { cost, price, ...rest } = p; // hide supplier cost
      return { ...rest, sell: gp, memberPrice: mp, guestPrice: gp, pricePerGb: p.sizeMb ? mp / (p.sizeMb / 1024) : 9999 };
    });
    // mark best value per network (lowest price per GB)
    const bestPerNet = {};
    for (const p of enriched) {
      const k = p.network;
      if (!bestPerNet[k] || p.pricePerGb < bestPerNet[k].pricePerGb) bestPerNet[k] = p;
    }
    for (const p of enriched) p.bestValue = bestPerNet[p.network] && String(bestPerNet[p.network].id) === String(p.id);
    res.json({ products: enriched, source: mockEnabled() ? "mock" : "live", updated: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Data is temporarily unavailable. Please try again shortly." });
  }
});

app.post("/api/order", rateLimit(LIMIT_WINDOW, ORDER_MAX), async (req, res) => {
  try {
    const raw = req.body || {};
    if (!requireTermsAgreed(raw)) return res.status(400).json({ error: "Please tick the box agreeing to the terms before you pay.", code: "terms_not_agreed" });
    const planId = raw.planId;
    const network = raw.network;
    const phone = raw.phone;
    const email = raw.email;
    const name = raw.name;
    const payMode = raw.payMode;
    // strict type checks per SCAN-REPORT-2
    if (typeof planId !== "string" || !planId.trim()) return res.status(400).json({ error: "Please choose a bundle." });
    if (typeof phone !== "string") return res.status(400).json({ error: "Enter a valid beneficiary number." });
    if (payMode !== undefined && payMode !== null && payMode !== "" && !["paystack","manual"].includes(String(payMode))) return res.status(400).json({ error: "Invalid payment method." });
    if (network !== undefined && typeof network !== "string") return res.status(400).json({ error: "Invalid network." });
    const digits = String(phone || "").replace(/\D/g, "");
    if (!/^[0-9]{9,13}$/.test(digits)) return res.status(400).json({ error: "Enter a valid beneficiary number." });
    if (isBlocked(digits)) return res.status(403).json({ error: "This number cannot buy data. Please contact us on WhatsApp.", code: "number_blocked" });
    if (email !== undefined && email !== "" && (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(String(email).trim())))
      return res.status(400).json({ error: "Enter a valid email (optional)." });
    if (name !== undefined && (typeof name !== "string" || String(name).trim().length > 60)) return res.status(400).json({ error: "Name too long." });

    const products = await idatagh.listProducts();
    const plan = products.find((p) => String(p.id) === String(planId));
    if (!plan) return res.status(404).json({ error: "Selected bundle not found." });
    /* If the request names a different network than the bundle it chose, refuse it
       here rather than store an order that can never be delivered correctly. The
       stored network always comes from the catalogue; this only catches a wrong or
       tampered request before any money is taken. */
    if (network) {
      const want = String(network).toLowerCase().replace(/[\s\-/]/g, "");
      const got = String(plan.network || "").toLowerCase().replace(/[\s\-/]/g, "");
      if (want && got && want !== got) {
        return res.status(400).json({ error: "That bundle is not on the network you selected. Please pick the bundle again." });
      }
    }

    // Price depends on logged-in status: members pay member price, guests pay guest price
    const sess = userFromReq(req);
    const member = sess ? loadUsers().find((u) => u.id === sess.id) : null;
    const isMember = Boolean(member);
    const price = priceFor(plan, isMember).price;
    const availability = await supplierPurchaseGuard(plan.cost);
    if (!availability.ok) return res.status(availability.status).json({ error: availability.error, outOfStock: Boolean(availability.outOfStock) });

    // P3+SCAN-2: limit 3 open unpaid per beneficiary number, 5 per IP via rateLimit
    if (payMode !== "paystack") {
      const openByPhone = loadOrders().filter(o => o.status === "pending" && o.source === "manual" && o.phone === digits).length;
      if (openByPhone >= 3) return res.status(429).json({ error: "Too many open unpaid orders for this number. Pay or cancel existing ones first." });
    }

    // Our supplier (iDATA) rejects a second order for the same number sent at the
    // same time and gives no refund for it, so this would be a silent loss. One
    // open order per number inside a short window is the honest rule; after that
    // the customer is allowed to buy again, because a genuine second purchase
    // later in the day is a real sale, not an accident.
    const clash = recentOrderForNumber(digits, SAME_NUMBER_WINDOW_MS);
    if (clash) {
      return res.status(409).json({
        error: `You already have an order for ${digits} from ${new Date(clash.created).toLocaleString()}. Placing a second order for the same number at the same time can get one of them stuck with no refund. Please wait until that order completes before ordering again.`,
        code: "same_number_too_soon", orderId: clash.id,
      });
    }

    const order = newOrder();
    order.planName = plan.name;
    order.planId = String(plan.id);
    /* The network ALWAYS comes from the catalogue, never from the request. It used
       to be `network || plan.network || "MTN"`, which let the client's value win
       over the bundle actually chosen and fell back to MTN when it was absent. */
    order.network = plan.network;
    order.phone = digits;
    order.email = email ? String(email).trim().slice(0, 254) : null;
    order.name = name ? String(name).trim().slice(0, 60) : null;
    order.cost = plan.cost;
    order.sell = price;
    order.isMemberPrice = isMember;
    // Attach the order to a signed-in member's account so it shows in "My purchases"
    // (MoMo/manual orders used to vanish from the account they were paid from).
    if (member) order.userId = member.id;
    order.currency = CURRENCY;
    order.reference = crypto.randomBytes(10).toString("hex").slice(0, 12);
    order.termsVersion = TERMS_VERSION;
    order.termsAcceptedAt = new Date().toISOString();
    order.ip = req.ip || "?";

    if (payMode === "paystack" && paystack.initialized()) {
      const init = await paystack.initializeOrder({ amount: order.sell, email: order.email || "customer@example.com", orderId: order.id });
      order.status = "pending_payment";
      order.paystackRef = init.reference;
      saveOrders([...loadOrders(), order]);
      return res.json({ ok: true, payment: { type: "paystack", url: init.authorization_url, reference: init.reference, orderId: order.id }, order: publicOrder(order) });
    }

    order.status = "pending";
    saveOrders([...loadOrders(), order]);
    res.json({
      ok: true,
      order: publicOrder(order),
      payment: {
        type: "manual",
        note: cfg("DEFAULT_PAY_NOTE", "Pay now and we deliver."),
        amount: order.sell,
        currency: CURRENCY,
        orderId: order.id,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "We could not place this order right now. Please try again shortly." });
  }
});

function publicOrder(o) {
  return {
    id: o.id, trackCode: o.trackCode || null, status: o.status, planName: o.planName, network: o.network,
    phone: o.phone, currency: o.currency, sell: o.sell, reference: o.reference,
    progress: orderProgress(o),
  };
}

function trackingOrder(o) {
  return {
    id: o.id,
    trackCode: o.trackCode || null,
    status: o.status,
    planName: o.planName,
    network: o.network,
    created: o.created,
    progress: orderProgress(o),
    sell: o.sell,
    currency: o.currency,
  };
}

app.post("/api/order/track", rateLimit(60 * 1000, 10), (req, res) => {
  const code = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!/^PD-[A-F0-9]{10}$/.test(code)) return res.status(400).json({ error: "Enter the tracking code from your order confirmation." });
  const order = loadOrders().find((o) => String(o.trackCode || "").toUpperCase() === code);
  if (!order) return res.status(404).json({ error: "No order matches that tracking code." });
  res.json(trackingOrder(order));
});

/* Order status lookup: legacy safe path: requires the beneficiary number's last 4 digits. */
app.post("/api/order/status", rateLimit(60*1000, 10), (req, res) => {
  const id = String((req.body && req.body.id) || "").trim().toUpperCase();
  const suffix = String((req.body && req.body.phone) || "").replace(/\D/g, "").slice(-4);
  if (id.length < 4 || suffix.length !== 4) return res.status(400).json({ error: "Enter the order ref and the last 4 digits of the beneficiary number." });
  const order = loadOrders().find((o) => o.id === id && o.phone.replace(/\D/g, "").slice(-4) === suffix);
  if (!order) return res.status(404).json({ error: "No order matches those details." });
  res.json(trackingOrder(order));
});

function verifyPaystackSignature(sig, rawBody) {
  const secret = cfg("PAYSTACK_SECRET_KEY", "");
  if (!secret) return false;
  const h = crypto.createHmac("sha512", secret).update(rawBody || "").digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(sig||""))); } catch { return false; }
}
/* The one place a paid card order is turned into delivered data. The webhook and
   the background reconciler both call this, so the two can never drift apart and
   no payment path can fulfil an order differently from another. */
/* Every attempt to hand a paid order to the supplier goes through here, so a
   failure can never again be recorded as "processing".

   That was the bug that cost money: on a supplier timeout the catch block set
   status = "processing". Processing means "the supplier has it and is working on
   it", so the customer was told their data was on its way, the owner was told the
   order was fine and in progress, nothing alerted anybody, and nothing retried.
   The customer had paid and the supplier had never heard of the order. The manual
   path already used "failed", and now both agree.

   A timeout is genuinely ambiguous: the request may or may not have reached the
   supplier. That is why the order is NOT retried automatically. iDATA's own notice
   says a second order for the same number in the same period is rejected with no
   refund, so a blind retry could turn one lost sale into two. Instead the order
   carries our own reference, which is what iDATA needs in order to look it up, and
   the owner is told to check before deciding between re-sending and refunding. */
function markSupplierSendFailed(orders, order, reason) {
  order.status = "failed";
  order.error = String(reason || "unknown error").slice(0, 200);
  order.providerStatus = "not-sent";
  order.providerMessage = "The supplier did not accept this order. The customer has paid and has not received data.";
  order.sendFailedAt = new Date().toISOString();
  order.sendAttempts = (Number(order.sendAttempts) || 0) + 1;
  alertAdmin("supplier",
    `Order ${order.id} (${order.planName}, GHS ${Number(order.sell).toFixed(2)}, ${order.phone}) was NOT sent to the supplier. Reason: ${order.error}. The customer has paid and has no data. Reference for iDATA: ${order.reference}. Check with iDATA before re-sending, then use Send to supplier or refund.`,
    `send-failed:${order.id}`);
  return order;
}

/* ---------- the single gate every supplier send must pass ----------

   Independent review (2026-09-29, Arena branch) found that the two ADMIN send
   routes - "Process" and "Mark paid & send" - did NOT obey the durable-claim rule
   that the automatic path obeys. They read the guard, called the supplier, and
   only wrote afterwards. That is the same bug as the original outage, triggered by
   a person instead of a loop: a double press, a client timeout retry, the same
   dashboard open on two devices, or a crash mid-send all buy the bundle TWICE for
   one payment. It was reproduced three ways in test/supplier-send-safety.js.

   So there is now exactly one function that may spend supplier money, and it
   always does the same three things in this order:
     1. take the in-process lock, so two concurrent requests cannot both proceed
     2. re-read the order from disk and re-check every guard
     3. write the claim to disk BEFORE contacting the supplier

   The on-disk claim is the field `autoSendTriedAt`. The name is historical - it
   now means "a supplier send was claimed for this order", whoever triggered it -
   and it is deliberately NOT renamed, because existing orders already carry it and
   two claim fields is exactly the divergence this function exists to remove.

   A claim is never cleared automatically, even on a timer. A timeout is
   ambiguous: the request may or may not have reached the supplier, and a blind
   retry is how one lost sale becomes two. A claimed-but-unconfirmed order is
   parked for the owner to check with iDATA first. */
function sendClaimed(o) {
  return Boolean(o && o.autoSendTriedAt);
}

/* Returns { ok:false, code, error } without spending anything, or { ok:true, order }
   after the result has been written to disk. */
async function claimOrderForSend(orderId) {
  if (sendLock.has(orderId)) {
    return { ok: false, code: 409, error: "That order is already being sent to the supplier. Wait for it to finish." };
  }
  sendLock.add(orderId);
  try {
    /* Always re-read from disk. The caller's copy may be stale: a webhook, a
       reconciler or another admin press may have claimed this order while the
       request was in flight. */
    const rows = loadOrders();
    const order = rows.find((o) => o.id === orderId);
    if (!order) return { ok: false, code: 404, error: "Order not found" };

    /* Every guard, re-checked against the freshest copy. A supplier reference
       means iDATA already has the order, and their notice is explicit that a
       second order for the same number in the same period is rejected with NO
       refund. A recorded attempt means this order was already tried, even if no
       reference came back. The one order that may be retried is one the supplier
       actively REJECTED, because a rejection means iDATA never created it. */
    if (order.providerRef) {
      return { ok: false, code: 409, error: "This order was already sent to the supplier, so it cannot be sent again. Check its status instead." };
    }
    if (sendClaimed(order)) {
      return { ok: false, code: 409, error: "This order was already claimed for sending to the supplier, but no supplier reference came back. It will not be sent again automatically. Check with iDATA first, then use the confirmed override if it truly never reached them." };
    }
    if (Number(order.sendAttempts) > 0 && order.status !== "failed") {
      return { ok: false, code: 409, error: `This order has already been sent to the supplier (${order.sendAttempts} attempt${Number(order.sendAttempts) === 1 ? "" : "s"}). It will not be sent again. If the supplier rejected it, check with iDATA first.` };
    }

    /* THE CLAIM. Written and fsync'd to disk before the supplier is contacted, so
       a crash, a kill, or a process restart cannot leave this order looking
       unsent when the supplier may already have it. */
    order.autoSendTriedAt = new Date().toISOString();
    order.status = "paid";
    order.awaitingApproval = false;
    saveOrders(rows);

    const sent = await sendOrderToSupplier(rows, order);
    /* Persist the RESULT, so a successful send leaves a supplier reference on
       disk and the admin stops offering a Send button for an order that has
       already been bought. */
    saveOrders(rows);
    return { ok: true, order, sent };
  } finally {
    sendLock.delete(orderId);
  }
}

async function sendOrderToSupplier(orders, order) {
  try {
    /* The network MUST be passed. It was missing here, and buyBundle's slugify
       used to fall back to "mtn" for an empty value, so every order was bought
       from the supplier as MTN no matter what the customer paid for. On
       2026-09-29 that sent an MTN bundle for a paid Telecel 10GB order: the
       owner paid for data the customer's SIM could not use. */
    const result = await idatagh.buyBundle({
      planId: order.planId, network: order.network, phone: order.phone, reference: order.reference,
    });
    order.error = "";
    order.sendAttempts = (Number(order.sendAttempts) || 0) + 1;
    applyProviderResult(order, result);
    return true;
  } catch (e) {
    markSupplierSendFailed(orders, order, e.message);
    return false;
  }
}

/* ---------- automatic approval after a confirmed card payment ----------
   The customer has already paid by card, so the data must go out without the owner
   clicking, or card sales stop working. The earlier automatic path had no durable
   "already tried" marker, so a 60-second retry loop re-bought the same order over
   and over and drained the owner's supplier wallet. Two rules make automatic
   approval safe, and both are enforced here and nowhere else:
     1. autoSendTriedAt is written to disk BEFORE the supplier is contacted, so an
        order can never be sent twice, even across a crash, a webhook arriving at the
        same moment as the reconciler, or a status that was edited by hand.
     2. There is NO automatic retry. If the send fails the order is parked in `failed`
        for the owner to decide. A blind retry is what cost the money: iDATA rejects a
        second order for the same number in the same period with no refund, so a retry
        turns one lost sale into two. */
const sendLock = new Set();
function autoSendBlocked(o) { return !!(o && o.autoSendTriedAt); }

async function autoApproveAndSend(orders, order) {
  if (!order || autoSendBlocked(order) || sendLock.has(order.id)) return false;
  sendLock.add(order.id);
  try {
    // Re-read so a webhook landing while we waited wins, and so the durable claim
    // below is always written against the freshest copy on disk.
    const rows = loadOrders();
    const live = rows.find((o) => o.id === order.id);
    if (!live || live.status !== "pending_payment" || autoSendBlocked(live)) return false;

    /* The owner has automatic approval switched OFF. Record the payment, then park
       the order for a human. The money is never un-credited and no data is sent:
       it simply waits, with the exact network, bundle and cost shown in the admin,
       until the owner presses Process. This is the owner's decision to make and it
       is never overridden by any code path. */
    const auto = autoApproveState();
    if (!auto.on) {
      live.status = "paid";
      live.verifiedAt = new Date().toISOString();
      live.awaitingApproval = true;
      live.providerRef = null;
      live.error = "";
      live.sendAttempts = 0;
      saveOrders(rows);
      creditReferralOnFirstPurchase(live.userId);
      activity("order", `Payment confirmed for order ${live.id} (GHS ${Number(live.sell).toFixed(2)}, ${live.planName} / ${live.network} to ${live.phone}). Automatic approval is OFF, so nothing was sent to the supplier.`);
      alertAdmin("topup", `Payment received for order ${live.id}: GHS ${Number(live.sell).toFixed(2)}, ${live.planName} (${live.network}) for ${live.phone}. Automatic approval is OFF, so nothing has been sent to the supplier. Press Process to send it.`, `awaiting-approval:${live.id}`);
      return false;
    }

    // Durably claim this order as "attempted" BEFORE any supplier call. This single
    // write is the idempotency guarantee for the whole automatic flow.
    live.status = "paid";
    live.verifiedAt = new Date().toISOString();
    live.awaitingApproval = false;
    live.autoSendTriedAt = new Date().toISOString();
    live.providerRef = null;
    live.error = "";
    saveOrders(rows);
    creditReferralOnFirstPurchase(live.userId);
    activity("order", `Payment confirmed for order ${live.id} (GHS ${Number(live.sell).toFixed(2)}, ${live.planName} to ${live.phone}). Sending to the supplier automatically.`);
    const ok = await sendOrderToSupplier(rows, live);
    /* Persist the RESULT. This was missing, and it mattered: a successful
       automatic send left providerRef and sendAttempts empty on disk, so the
       admin showed "Not sent to supplier" and offered a Send button. The server
       guards key off providerRef and sendAttempts, so both read empty and a
       second press would have bought the bundle AGAIN. Found by testing the
       switch on a scratch instance, not by reading the code. */
    saveOrders(rows);
    if (ok) {
      alertAdmin("topup", `Payment received for order ${live.id}: GHS ${Number(live.sell).toFixed(2)}, ${live.planName} for ${live.phone}. The data was sent to the supplier automatically.`, `auto-sent:${live.id}`);
    } else {
      alertAdmin("supplier", `Order ${live.id} was PAID and the automatic send FAILED. The customer has paid and has no data, and there will be NO automatic retry. Reference for iDATA: ${live.reference}. Use Send to supplier or refund in the admin.`, `auto-send-failed:${live.id}`);
    }
    return ok;
  } finally { sendLock.delete(order.id); }
}

app.post("/api/paystack/webhook", async (req, res) => {
  const sig = req.get("x-paystack-signature") || req.get("X-Paystack-Signature") || "";
  const event = req.body;
  // Log every single arrival. A webhook that works is silent otherwise, which
  // makes "is it actually being called?" unanswerable from the server.
  console.log(`[paystack webhook] ${event && event.event ? event.event : "unknown event"} ref=${event && event.data && event.data.reference ? event.data.reference : "-"} sig=${sig ? "yes" : "MISSING"}`);
  if (!verifyPaystackSignature(sig, req.rawBody)) { alertAdmin("security", "Paystack webhook rejected (bad signature)"); return res.status(401).end(); }
  if (!event || event.event !== "charge.success") return res.status(200).end();
  const ref = event.data && event.data.reference;
  const amt = event.data && event.data.amount; // kobo

  /* ---- wallet top-up? ---- */
  const topups = loadTopups();
  const top = topups.find((t) => t.paystackRef === ref);
  if (top) {
    // Idempotent: a replayed webhook must never credit twice.
    if (top.credited || top.status === "paid") return res.status(200).end();
    const expectedKobo = Math.round(Number(top.amount) * 100);
    if (Number(amt) !== expectedKobo) {
      top.status = "failed";
      top.error = "Amount mismatch";
      top.handledAt = new Date().toISOString();
      saveTopups(topups);
      alertAdmin("security", `Top-up ${top.id} amount mismatch: paid ${(Number(amt) / 100).toFixed(2)} but expected ${top.amount.toFixed(2)}, NOT credited`);
      return res.status(200).end();
    }
    const r = creditTopupOnce(topups, top);
    saveTopups(topups);
    if (!r.ok) alertAdmin("topup", `Top-up ${top.id} was PAID by card but was NOT credited. ${r.error}`, `topup-noacct:${top.id}`);
    else alertAdmin("topup", `GHS ${r.amount.toFixed(2)} received from ${r.user.name}. Wallet credited automatically.`, `topup-auto:${top.id}`);
    return res.status(200).end();
  }
  /* ---- order payment ---- */
  const orders = loadOrders();
  const order = orders.find((o) => o.paystackRef === ref);
  if (!order) { alertAdmin("security", `Paystack charge for unknown reference ${ref}. No order or top-up matched.`); return res.status(200).end(); }
  if (order.status !== "pending_payment") {
    // The order was already handled, and Paystack retries webhooks, so a repeat
    // here is normal and must stay silent. The exception is money landing on an
    // order that was closed without the customer ever getting data: then the
    // owner is owed a refund and would otherwise never know it happened.
    if (["cancelled", "refunded", "failed"].includes(order.status)
      && String((event.data && event.data.status) || "").toLowerCase() === "success") {
      alertAdmin("topup", `Paystack charged GHS ${(Number(amt) / 100).toFixed(2)} for order ${order.id}, but that order was ${order.status} and the customer did NOT get their data. Check whether they need a refund.`, `paystack-closed-order:${order.id}`);
    }
    return res.status(200).end();
  }
  const expectedKobo = Math.round(Number(order.sell) * 100);
  if (Number(amt) !== expectedKobo) { order.status = "failed"; order.error = "Amount mismatch"; saveOrders(orders); alertAdmin("security", `Order ${order.id} amount mismatch, not fulfilled`); return res.status(200).end(); }
  if (order && order.status === "pending_payment") {
    /* Payment confirmed. Approve and deliver via the single guarded automatic path
       (shared with the reconciler, so the two cannot diverge or double-send). */
    const delivered = await autoApproveAndSend(orders, order);
    console.log(`[paystack webhook] PAYMENT CONFIRMED for order ${order.id} (${order.planName}, GHS ${order.sell}) to ${order.phone}. Auto-send ${delivered ? "succeeded" : "failed - no retry, owner action needed"}.`);
  }
  res.status(200).end();
});

/* ---------- admin API ---------- */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

// Orders only, with no supplier call. The dashboard summary also asks iDATA for
// the wallet balance, so polling it every few seconds would hammer the supplier.
// This endpoint exists so the admin can watch for new orders cheaply.
app.get("/api/admin/orders", requireAdmin, rateLimit(LIMIT_WINDOW, 240), (req, res) => {
  const orders = loadOrders();
  res.json({
    orders: orders.slice(-60).reverse().map((o) => ({ ...o, progress: orderProgress(o) })),
    pending: orders.filter((o) => ["pending", "pending_payment", "paid"].includes(o.status)).length,
    at: new Date().toISOString(),
  });
});
app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  const orders = loadOrders();
  const wallet = await idatagh.walletBalance().catch(() => ({ balance: null }));
  res.json({
    orders: orders.slice(-60).reverse().map((o) => ({ ...o, progress: orderProgress(o) })),
    totalOrders: orders.length,
    pending: orders.filter((o) => ["pending", "pending_payment", "paid"].includes(o.status)).length,
    delivered: orders.filter((o) => o.status === "delivered").length,
    revenue: orders.reduce((s, o) => s + (o.status === "delivered" ? Number(o.sell) || 0 : 0), 0).toFixed(2),
    wallet,
    customers: loadUsers().length,
    topupPending: loadTopups().filter((t) => t.status === "pending").length,
    config: {
      apiMock: mockEnabled(),
      apiUrl: cfg("IDATAGH_API_URL"),
      paystackOn: paystack.initialized(),
      adminUser: req.admin.user,
    },
  });
});

/* Blocked numbers: list, add, remove. Admin-only. The reason is stored for the
   admin but never returned to a customer. */
app.get("/api/admin/blocked", requireAdmin, (req, res) => {
  res.json({ blocked: loadBlocked() });
});

app.post("/api/admin/blocked", requireAdmin, rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  const phone = blockKey(req.body && req.body.phone);
  if (!/^0[245][0-9]{8}$/.test(phone)) return res.status(400).json({ error: "Enter a valid Ghana number, e.g. 0550000000." });
  const list = loadBlocked();
  if (list.some((b) => blockKey(b.phone) === phone)) return res.status(200).json({ ok: true, already: true, blocked: list });
  const reason = String((req.body && req.body.reason) || "Blocked by owner").slice(0, 120);
  list.push({ phone, reason, at: new Date().toISOString() });
  saveBlocked(list);
  activity("security", `Blocked number ${phone}: ${reason}`);
  alertAdmin("security", `Number ${phone} is now blocked from buying data. Reason: ${reason}`);
  res.json({ ok: true, blocked: list });
});

app.delete("/api/admin/blocked/:phone", requireAdmin, (req, res) => {
  const phone = blockKey(req.params.phone);
  const list = loadBlocked();
  const next = list.filter((b) => blockKey(b.phone) !== phone);
  if (next.length === list.length) return res.status(404).json({ error: "That number is not blocked." });
  saveBlocked(next);
  activity("security", `Unblocked number ${phone}`);
  res.json({ ok: true, blocked: next });
});

app.get("/api/admin/unpaid", requireAdmin, (req, res) => {
  const list = loadOrders().filter(o => o.status === "pending" && o.source === "manual").slice(-100).reverse();
  res.json({ orders: list.map(o => ({ id: o.id, planName: o.planName, network: o.network, phone: o.phone, sell: o.sell, created: o.created, ip: o.ip })) });
});
app.post("/api/admin/orders/:id/mark-paid", requireAdmin, rateLimit(LIMIT_WINDOW, 40), async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  // "pending" = MoMo/cash order awaiting the owner's confirmation.
  // "pending_payment" = a card payment that never confirmed (Paystack disabled or
  // abandoned), which the owner must still be able to approve once the customer
  // pays another way, or the order can never be fulfilled at all.
  if (!["pending", "pending_payment"].includes(order.status)) return res.status(409).json({ error: "Not pending" });
  /* "pending" = MoMo/cash order awaiting the owner's confirmation.
     "pending_payment" = a card payment that never confirmed (Paystack disabled or
     abandoned), which the owner must still be able to approve once the customer
     pays another way, or the order can never be fulfilled at all. */
  if (order.providerRef || Number(order.sendAttempts) > 0) {
    return res.status(409).json({ error: "This order has already been sent to the supplier and will not be sent again." });
  }
  /* Every supplier purchase, by any route, goes through the one claimed gate. It
     writes the claim to disk BEFORE contacting iDATA and re-checks every guard
     against a fresh read, which is what stops a double press or a crash from
     buying the same bundle twice for one payment. */
  const claim = await claimOrderForSend(order.id);
  if (!claim.ok) return res.status(claim.code).json({ error: claim.error });
  creditReferralOnFirstPurchase(claim.order.userId);
  res.json({ ok: true, order: publicOrder(claim.order), providerError: claim.order.error || null });
});
app.post("/api/admin/orders/:id/cancel", requireAdmin, (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  // Anything where no money has been taken and no data has been sent can be
  // cancelled by the owner. "pending_payment" is a card payment the customer
  // started and never completed, so Cancel has to work there too, or an
  // abandoned checkout sits in the list for 24 hours with no way out.
  //
  // "paid" and "processing" are ALSO cancellable, but ONLY when nothing was ever
  // sent to the supplier (no reference, no send attempt). That is the exact state
  // the "Refund / close" button appears on: the customer paid, and we have nothing
  // to show for it. Before this rule existed the admin offered that button and the
  // server always answered 409, so a customer who paid and received nothing could
  // not be closed out from the admin at all. Cancelling here records WHY (see
  // cancelReason) so the record never quietly looks like a normal close.
  const nothingSent = !order.providerRef && !(Number(order.sendAttempts) > 0) && !order.autoSendTriedAt;
  const cancellable = ["pending", "pending_payment", "failed"].includes(order.status)
    || (["paid", "processing"].includes(order.status) && nothingSent);
  if (!cancellable) return res.status(409).json({ error: `This order can no longer be cancelled (status: ${order.status}). If the data was already sent, close it with Refund instead.` });
  /* Work out whether this customer already paid BEFORE the status is rewritten
     below. Reading the status after this point would always say "cancelled" and a
     paid order would then be recorded as an unpaid close, which is the exact
     confusion this change exists to remove. */
  const tookMoney = Boolean(order.paystackRef) || Boolean(order.verifiedAt) || Boolean(order.autoSendTriedAt)
    || ["paid", "processing", "refunded", "delivered"].includes(order.status);
  // 2: admin-only refund, if wallet order refund to wallet
  if (order.source === "wallet" && order.userId && order.status === "failed") {
    const users = loadUsers();
    const u = users.find(x => x.id === order.userId);
    if (u) { u.wallet = Math.round((u.wallet + order.sell) * 100) / 100; saveUsers(users); order.status = "refunded"; order.refundedAt = new Date().toISOString(); activity("order", `Refunded GHS ${order.sell.toFixed(2)} to ${u.name} for ${order.id} (cancel)`); }
    else order.status = "cancelled";
  } else if (order.source === "wallet" && order.userId && order.status === "pending") {
    // pending wallet orders shouldn't happen (we keep deducted), but allow refund on cancel
    const users = loadUsers();
    const u = users.find(x => x.id === order.userId);
    if (u) { u.wallet = Math.round((u.wallet + order.sell) * 100) / 100; saveUsers(users); order.status = "refunded"; order.refundedAt = new Date().toISOString(); activity("order", `Refunded GHS ${order.sell.toFixed(2)} to ${u.name} for ${order.id} (cancel pending)`); }
    else order.status = "cancelled";
  } else {
    order.status = "cancelled";
  }
  /* An order that had already been paid must never close looking like an unpaid
     one. Recording the money explicitly means the admin can always answer "did
     this customer get their money back?" from the record alone. */
  order.cancelReason = tookMoney
    ? "cancelled by admin: payment was taken and no data was ever sent to the supplier (refund owed to customer)"
    : "cancelled by admin";
  order.cancelledAt = new Date().toISOString();
  if (tookMoney) {
    order.refundOwed = true;
    alertAdmin("refund", `Order ${order.id} was cancelled by admin but the customer had ALREADY PAID GHS ${Number(order.sell).toFixed(2)} (${order.planName} / ${order.network}) and no data was ever sent. Refund this customer GHS ${Number(order.sell).toFixed(2)} to ${order.phone}.`, `refund-owed:${order.id}`);
    activity("order", `Cancelled order ${order.id} which had a completed payment of GHS ${Number(order.sell).toFixed(2)}. No data was sent. REFUND OWED to the customer.`);
  }
  saveOrders(orders);
  res.json({ ok: true, status: order.status, refundOwed: Boolean(order.refundOwed) });
});
/* ---------- refunds ----------
   Returning a customer's money is the one action that can be done twice by a retry
   and cost real money a second time, so it obeys the same rule as the supplier
   send: claim it on disk FIRST, then call the payment provider, and never retry on
   our own initiative.

   Before this existed the only refund was to an in-app wallet, for a failed wallet
   order. A customer who paid by card and could not be delivered had no route at
   all, and pressing "Refund / close" on a failed card order marked it cancelled
   with no money returned at all. */

const REFUND_LOCK = new Set();

/* What a given order still needs doing about money. This is the single rule the
   admin UI asks, so the screen and the server can never disagree about whether a
   refund is owed. */
function refundStateOf(order) {
  if (order.refundStatus === "refunded") return { owed: false, done: true, how: order.refundMethod || "unknown" };
  if (order.refundStatus === "pending") return { owed: true, done: false, blocked: "a refund for this order is already with Paystack" };
  if (order.refundStatus === "failed") return { owed: true, done: false, blocked: "the last refund attempt did not complete" };
  const tookMoney = Boolean(order.paystackRef) || Boolean(order.verifiedAt) || ["paid", "processing", "delivered", "refunded", "cancelled"].includes(order.status);
  if (!tookMoney) return { owed: false, done: false };
  if (order.refundOwed) return { owed: true, done: false };
  if (["paid", "processing"].includes(order.status) && !order.providerRef) return { owed: true, done: false };
  return { owed: false, done: false };
}

app.post("/api/admin/orders/:id/refund", requireAdmin, rateLimit(LIMIT_WINDOW, 20), async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!paystack.initialized()) return res.status(503).json({ error: "Refunds need the Paystack key, which is not set on this server." });
  if (order.status === "delivered") return res.status(409).json({ error: "This order was delivered, so there is nothing to refund. Close it instead." });
  /* Independent review (2026-09-29) found this route only refused `delivered`, so
     a `processing` order that ALREADY carries a supplier reference - iDATA has
     accepted it and the data may be minutes away - was refunded. The customer is
     paid back AND receives the bundle.

     refundStateOf() already reported owed:false for that shape, so the admin did
     not even offer the button, but the rule was never enforced on the route that
     moves money. A read-only check is not a control.

     The owner is allowed to override this deliberately, because the legitimate
     case is real: iDATA accepted an order and then never delivered it. That
     cannot be decided from this screen, so it requires an explicit confirmation
     and is written to the activity log. */
  const inFlight = ["paid", "processing"].includes(order.status) && Boolean(order.providerRef);
  if (inFlight && req.body && req.body.confirmInFlight !== true) {
    return res.status(409).json({
      error: "The supplier already has this order, so refunding now could pay you twice. Check with iDATA first; if they never delivered it, press again to confirm the refund.",
      inFlight: true,
    });
  }
  if (inFlight) {
    activity("refund", `Owner confirmed a refund for order ${order.id} DESPITE the supplier holding it (${order.providerRef}). GHS ${Number(order.sell).toFixed(2)} will be returned. This is only correct if iDATA never delivered the bundle.`);
  }
  if (order.refundStatus === "refunded") return res.status(409).json({ error: "This order has already been refunded." });
  if (order.refundStatus === "pending") return res.status(409).json({ error: "A refund for this order is already with Paystack. Do not refund it again." });
  if (REFUND_LOCK.has(order.id)) return res.status(409).json({ error: "That refund is already being processed." });

  /* Wallet refund: the money never left our own system, so this is a local credit
     and needs no provider call. Still guarded by the lock and the durable
     refundedAt marker, so a double press cannot pay twice. */
  if (order.source === "wallet" && order.userId) {
    const users = loadUsers();
    const u = users.find(x => x.id === order.userId);
    if (!u) return res.status(404).json({ error: "Customer account not found" });
    REFUND_LOCK.add(order.id);
    try {
      u.wallet = round2(u.wallet + order.sell);
      saveUsers(users);
      order.status = "refunded";
      order.refundedAt = new Date().toISOString();
      order.refundStatus = "refunded";
      order.refundMethod = "wallet";
      order.refundOwed = false;
      saveOrders(orders);
      activity("order", `Refunded GHS ${Number(order.sell).toFixed(2)} to ${u.name} for order ${order.id} (${order.planName})`);
      res.json({ ok: true, method: "wallet", balance: u.wallet });
    } catch (e) {
      alertAdmin("refund", `Wallet refund for order ${order.id} FAILED: ${e.message}. GHS ${Number(order.sell).toFixed(2)} may or may not have been credited to ${u.name}. Check the balance before trying again.`, `refund-failed:${order.id}`);
      res.status(500).json({ error: "The wallet refund did not complete. Check the customer's balance before trying again." });
    } finally {
      REFUND_LOCK.delete(order.id);
    }
    return;
  }

  /* Card refund. The customer paid Paystack, so the money goes back through
     Paystack. Every branch below either moves money exactly once or refuses. */
  if (!order.paystackRef) return res.status(400).json({ error: "This order has no card payment, so there is nothing to refund at Paystack." });

  /* Re-read before doing anything. A second click, or a click that arrived while
     the first was still in flight, must see the first one's claim. */
  const current = loadOrders().find(o => o.id === order.id);
  if (!current) return res.status(404).json({ error: "Order not found" });
  if (current.refundStatus === "refunded" || current.refundStatus === "pending") {
    return res.status(409).json({ error: "This order was already refunded, or a refund is in progress. Do not refund it twice." });
  }

  REFUND_LOCK.add(order.id);
  try {
    /* Ask Paystack what has already been refunded, BEFORE claiming. If the owner
       already refunded by hand in the Paystack dashboard, this finds it and we
       record it instead of paying a second time. This is the single most likely
       way to double-refund, so it is checked first and treated as authoritative. */
    try {
      const existing = await paystack.refundsFor(current.paystackRef);
      const processed = (existing || []).filter(r => r && (r.status === "processed" || r.status === "success"));
      if (processed.length) {
        const rows0 = loadOrders();
        const t = rows0.find(o => o.id === current.id);
        t.refundStatus = "refunded";
        t.refundMethod = "paystack";
        t.refundedAt = new Date().toISOString();
        t.refundRef = processed[0].reference || processed[0].id || "already-refunded-at-paystack";
        t.status = "refunded";
        t.refundOwed = false;
        saveOrders(rows0);
        activity("order", `Order ${current.id} was already refunded at Paystack. Recorded it instead of refunding again (GHS ${Number(current.sell).toFixed(2)}).`);
        return res.json({ ok: true, method: "already-refunded", ref: t.refundRef });
      }
    } catch (probeErr) {
      /* A failed probe is NOT a reason to block the only route to return money. We
         simply cannot rely on it, so we fall through to the claim + send below,
         which is still protected by that durable claim. */
      console.warn(`[refund] could not read existing refunds for ${current.id}: ${probeErr.message}`);
    }

    /* CLAIM FIRST. This single write is the idempotency guarantee: a crash, a
       timeout, a duplicate click or a restart can never cause a second refund,
       because after this point the order is marked pending and every other path
       refuses it. */
    const rows = loadOrders();
    const claimed = rows.find(o => o.id === current.id);
    claimed.refundStatus = "pending";
    claimed.refundClaimedAt = new Date().toISOString();
    claimed.refundAmount = round2(current.sell);
    claimed.refundMethod = "paystack";
    saveOrders(rows);

    let done;
    try {
      done = await paystack.refundTransaction(current.paystackRef, {
        customer_note: "POLYMATH DATA HUB: we could not deliver your bundle",
        merchant_note: `Refund for order ${current.id} (${current.planName} / ${current.network})`,
      });
    } catch (err) {
      /* Marked FAILED, not pending, so the owner is told the truth. We never
         auto-retry: the request may or may not have reached Paystack, and a blind
         retry is exactly how a customer gets paid twice. */
      const after = loadOrders().map(o => (o.id === current.id
        ? { ...o, refundStatus: "failed", refundError: String(err.message).slice(0, 200), refundFailedAt: new Date().toISOString() }
        : o));
      saveOrders(after);
      activity("refund", `Refund of GHS ${Number(current.sell).toFixed(2)} for order ${current.id} did not complete: ${err.message}`);
      alertAdmin("refund", `Refund for order ${current.id} (GHS ${Number(current.sell).toFixed(2)}, ${current.phone}) did not complete: ${err.message}. It was NOT retried automatically. Check the Paystack dashboard for reference ${current.paystackRef} before trying again.`, `refund-failed:${current.id}`);
      return res.status(502).json({ error: `Paystack refused the refund: ${err.message}. It has not been retried. Check the Paystack dashboard before trying again.` });
    }

    const final = loadOrders().map(o => (o.id === current.id ? {
      ...o,
      status: "refunded",
      refundStatus: "refunded",
      refundRef: (done && (done.reference || done.id)) || "paystack",
      refundedAt: new Date().toISOString(),
      refundOwed: false,
    } : o));
    saveOrders(final);
    activity("refund", `Refunded GHS ${Number(current.sell).toFixed(2)} to the customer for order ${current.id} (${current.planName} / ${current.network}, ref ${current.paystackRef})`);
    res.json({ ok: true, method: "paystack", ref: (done && (done.reference || done.id)) || "paystack" });
  } finally {
    REFUND_LOCK.delete(order.id);
  }
});

/* A read-only check the admin uses before offering the refund button, so a charge
   the owner already refunded by hand is never offered for refund again. */
app.get("/api/admin/orders/:id/refund-check", requireAdmin, rateLimit(LIMIT_WINDOW, 60), async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const state = refundStateOf(order);
  const out = Object.assign({}, state, { amount: round2(order.sell), currency: order.currency || "GHS", ref: order.paystackRef || null });
  if (order.paystackRef && paystack.initialized()) {
    try {
      const rows = await paystack.refundsFor(order.paystackRef);
      const processed = (rows || []).filter(r => r && (r.status === "processed" || r.status === "success"));
      const pending = (rows || []).filter(r => r && r.status === "pending");
      if (processed.length) { out.owed = false; out.done = true; out.alreadyRefundedAtPaystack = true; }
      else if (pending.length) { out.owed = true; out.done = false; out.blocked = "a refund for this charge is already pending at Paystack"; }
    } catch (e) {
      out.probeFailed = true;
    }
  }
  res.json(out);
});
app.post("/api/admin/orders/:id/status", requireAdmin, rateLimit(LIMIT_WINDOW, 40), async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
    const next = String((req.body && req.body.status) || "");
    if (!["pending", "paid", "processing", "delivered", "failed", "cancelled"].includes(next))
      return res.status(400).json({ error: "Invalid status" });
    /* Re-sending is only ever safe when the supplier has never had this order. A
       supplier reference means iDATA already has it, and their notice is explicit
       that a second order for the same number in the same period is rejected with
       no refund, so those stay blocked no matter what the status says. An order
       with no reference was never accepted, so sending it cannot double-buy, and
       the owner must have the button: that is the case that happened silently and
       had to be fixed by hand. */
    if (next === "processing") {
      /* Never buy the same order twice. All of that reasoning now lives in one
         place - claimOrderForSend() - so the Process button, the Mark-paid button
         and the automatic path cannot drift apart again. It takes the in-process
         lock, re-reads the order from disk, re-checks every guard, and writes the
         durable claim BEFORE the supplier is contacted. */
      const claim = await claimOrderForSend(order.id);
      if (!claim.ok) return res.status(claim.code).json({ error: claim.error });
      return res.json({ order: publicOrder(claim.order), providerError: claim.order.error || null, sent: claim.sent });
    }
    order.status = next;
    saveOrders(orders);
    res.json({ order: publicOrder(order), providerError: order.error || null });
});

app.get("/account", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "account.html"));
});

app.get("/complete", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "complete.html"));
});
for (const p of ["mtn", "telecel", "airteltigo"]) {
  app.get(`/${p}`, (req, res) => res.sendFile(path.join(__dirname, "..", "public", `${p}.html`)));
}
for (const p of ["terms", "refund-policy", "privacy"]) {
  app.get(`/${p}`, (req, res) => res.sendFile(path.join(__dirname, "..", "public", `${p}.html`)));
}
app.get("/product", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "product-detail.html")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "sitemap.xml")));
app.get("/robots.txt", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "robots.txt")));
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "manifest.json")));
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "sw.js")));

/* ---------- iDATA delivery webhooks ---------- */
// idatagh POSTs order.{status} events here (URL: /api/idatagh/webhook).
// Verified with HMAC-SHA256 (X-Tera-Signature) over the raw body using
// IDATAGH_WEBHOOK_SECRET (returned by the /webhook-settings API).
app.post("/api/idatagh/webhook", rateLimit(LIMIT_WINDOW, 60), (req, res) => {
  if (!idatagh.verifyHmac(req.rawBody, req.get("X-Tera-Signature") || "", cfg("IDATAGH_WEBHOOK_SECRET")))
    return res.status(401).json({ error: "invalid webhook signature" });
  const b = req.body || {};
  const data = b.data || b.payload || b.result || {};
  const ref = String(b.order_id || b.orderId || data.order_id || data.orderId || b.reference || data.reference || b.id || data.id || "").trim();
  if (!ref) return res.json({ ok: true, error: "no order id" });

  const label = String(`${b.event || ""} ${b.status || ""} ${b.status_label || ""} ${data.status || ""}`).toLowerCase();
  let next;
  if (/complete|deliver|success/.test(label)) next = "delivered";
  else if (/reject|cancel|fail|error|refund/.test(label)) next = "failed";
  else next = "processing";

  const orders = loadOrders();
  const order = orders.find((o) =>
    String(o.providerRef || "") === ref || String(o.reference || "") === ref || String(o.id) === ref);
  if (!order) return res.json({ ok: true, error: "no matching order (maybe already handled)" });
  if (order.status === "refunded") return res.json({ ok: true, status: order.status });

  order.status = next;
  if (b.providerRef || b.reference_code || data.providerRef || data.reference_code) {
    order.providerRef = b.providerRef || b.reference_code || data.providerRef || data.reference_code;
  }
  const message = String(b.message || data.message || b.status_label || data.status_label || "").slice(0, 300);
  if (next === "processing") {
    order.providerMessage = message || "iDATA is still processing this order.";
    order.providerStatus = String(b.status || data.status || "processing").slice(0, 80);
    order.error = null;
  }
  if (next === "delivered") {
    order.deliveredAt = new Date().toISOString();
    order.providerMessage = message || "iDATA confirmed delivery.";
    order.providerStatus = String(b.status || data.status || "completed").slice(0, 80);
    order.error = null;
  }
  if (next === "failed") {
    order.error = message || "Delivery failed";
    order.providerMessage = order.error;
  }
  saveOrders(orders);
  res.json({ ok: true, status: next });
});

/* ---------- json 404 + error handling ---------- */
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed")) return res.status(400).json({ error: "Bad JSON" });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
  res.status(500).json({ error: "Something went wrong" });
});

if (!fs.existsSync(DATA_FILE)) saveOrders([]);
ensureTrackCodes();
collapseDuplicateAlerts();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`idatastore http://127.0.0.1:${PORT}  mock=${mockEnabled() ? "ON" : "OFF"} admin=${adminConfigured() ? "configured" : "NOT CONFIGURED"}`);

  /* A missing webhook secret used to be silent and fatal. The signature check now
     fails closed, which is correct, but that means delivery updates are being
     REJECTED and nobody would know. Say so loudly, once, at boot, so the owner
     sees it in the admin alerts rather than discovering it as orders that never
     reach "Delivered". */
  if (!mockEnabled() && !idatagh.webhooksConfigured()) {
    const msg = "Supplier webhook signing secret (IDATAGH_WEBHOOK_SECRET) is not set, so delivery updates are being REJECTED for safety. Orders will still be sent, but they will not be confirmed as delivered automatically. Get the secret from the supplier dashboard and paste it into the admin Payment keys screen.";
    console.warn(`[SECURITY] ${msg}`);
    alertAdmin("security", msg, "webhook-secret-missing");
  }
  // warm product cache in background (Medium 13)
  idatagh.listProducts().catch(()=>{}).then(()=>console.log("product cache warmed"));
});