/* The order record: its shape, its progress, and the jobs that age it out.
   Extracted from the single-file server so a change here cannot be confused with a
   change to the checkout routes, and so this file can be read on its own. */
const crypto = require("crypto");
const { cfg } = require("./config");
const { loadOrders, saveOrders, loadTopups, saveTopups } = require("./store");
const { alertAdmin, activity } = require("./alerts");

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

const OPEN_STATUSES = ["pending", "pending_payment", "paid", "processing"];

const SAME_NUMBER_WINDOW_MS = 30 * 60 * 1000;

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
        /* A claim with no reference means a send was STARTED and never came back. It
           cannot be repeated automatically, so the wording has to tell the owner what
           to do about it rather than only that something is wrong. */
        const claimed = o.sendClaimedAt || o.autoSendTriedAt;
        alertAdmin("supplier",
          claimed
            ? `Order ${o.id} (${o.planName}, GHS ${Number(o.sell).toFixed(2)}, ${o.phone}) was claimed for sending ${mins} minutes ago and the supplier never returned a reference. The customer has paid and may have no data. Check order ${o.reference} with iDATA first: if they never got it, release the claim ("Allow one more try") and then Send to supplier, or refund the customer. It will NOT be retried on its own.`
            : `Order ${o.id} (${o.planName}, GHS ${Number(o.sell).toFixed(2)}, ${o.phone}) has been paid for ${mins} minutes and was NEVER sent to the supplier (no supplier reference). The customer has paid and has no data. Use Send to supplier, or refund them. Reference: ${o.reference}.`,
          claimed ? `claim-unresolved:${o.id}` : `never-sent:${o.id}`);
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

const TERMS_VERSION = "2026-09-26";

function requireTermsAgreed(body) {
  // Deliberately strict: only a real boolean true counts, so a truthy string or
  // a 1 cannot be used to slip past the gate.
  return !!(body && body.terms === true);
}

/* The jobs that age orders out, started by the server at boot. Kept here so the
   schedule lives next to the rule it enforces. */
function startOrderJobs() {
  setInterval(expireUnpaid, 60 * 60 * 1000).unref();
  expireUnpaid();
  setInterval(expireAbandonedTopups, 60 * 60 * 1000).unref();
  setTimeout(expireAbandonedTopups, 5 * 1000).unref();
  setInterval(watchStuckOrders, 30 * 60 * 1000).unref();
  setTimeout(watchStuckOrders, 60 * 1000).unref();
}

module.exports = { ensureTrackCodes, OPEN_STATUSES, SAME_NUMBER_WINDOW_MS, recentOrderForNumber, validatedDupes, expireUnpaid, expireAbandonedTopups, STUCK_AFTER_MS, REPORT_WITHIN_MS, watchStuckOrders, mintTrackCode, newOrder, applyProviderResult, PROGRESS_STEPS, orderProgress, publicOrder, trackingOrder, TERMS_VERSION, requireTermsAgreed, startOrderJobs };
