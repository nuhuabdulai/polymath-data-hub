/* shared state + the helpers every tab uses.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
const $ = (s) => document.querySelector(s);
let timer = null;
let dashTab = "orders";
// The 30s auto-refresh must never throw away what the owner is typing.
let statusDirty = false;
let statusToken = 0;
/* New-order watching. The owner wants an order to appear quickly so they can
   approve it, but a silent table swap is easy to miss and the full summary also
   calls the supplier, so this polls an orders-only endpoint and flags what is
   new instead of moving the page under them. */
let orderPoll = null;
let ordersLive = true;          // the owner can pause it
let ordersSeeded = false;      // the first full load is the baseline, not "new"
let seenOrderIds = new Set();
let newOrderIds = new Set();
let lastCheckedAt = null;
let newOrderFade = null;
const ownerIsEditing = () => {
  const a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
};
// Polling a tab nobody is looking at is wasted work, and a background tab must
// not keep hitting the server either.
const canPollOrders = () =>
  ordersLive && dashTab === "orders" && !document.hidden && !ownerIsEditing() && Date.now() >= ARMED_UNTIL;

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const ORDER_STATUS_LABEL = { pending: "Pending payment", pending_payment: "Awaiting payment", paid: "Paid, processing", processing: "Processing", delivered: "Delivered", failed: "Failed", refunded: "Refunded", cancelled: "Cancelled" };

/* The label must never imply the supplier has the order when it does not. A flat
   "paid -> Paid, processing" was what made an unsent order look like ordinary
   progress on 2026-09-29, and it was read as fine for hours. The status alone is
   not enough, so this looks at whether anything was ever sent. */
function orderStatusLabel(statusOrOrder) {
  const o = typeof statusOrOrder === "string" ? { status: statusOrOrder } : (statusOrOrder || {});
  const s = o.status;
  const nothingSent = !o.providerRef && !(Number(o.sendAttempts) > 0) && !o.autoSendTriedAt && !o.sendClaimedAt;
  if (s === "paid" && nothingSent) return "Paid, not sent";
  if (s === "processing" && !o.providerRef) return nothingSent ? "Not sent" : "Sending, unconfirmed";
  if (s === "paid" && !o.providerRef && !nothingSent) return "Sending, unconfirmed";
  if (s === "paid") return "Paid, sending";
  return ORDER_STATUS_LABEL[s] || String(s || "n/a");
}

function toast(msg, isErr) {
  const feed = $("#feed");
  if (!feed) return;
  feed.textContent = msg;
  feed.style.color = isErr ? "#b91c1c" : "var(--muted)";
}

async function ajax(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
