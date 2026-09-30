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

function show(view) {
  $("#loginView").hidden = view !== "login";
  $("#dashView").hidden = view !== "dash";
}

function setTab(tab) {
  dashTab = tab;
  document.querySelectorAll(".admin-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    // The tab bar scrolls horizontally on a phone, so make sure the tab the
    // owner just tapped is actually visible.
    if (on && b.scrollIntoView) b.scrollIntoView({ block: "nearest", inline: "center" });
  });
  ["orders", "users", "topups", "logs", "messaging", "status", "pricing", "sales"].forEach((t) => ($(`#${t}View`).hidden = t !== tab));
  loadActive();
}

function loadActive(force) {
  if (dashTab === "users") return loadUsers();
  if (dashTab === "topups") return loadTopups();
  if (dashTab === "logs") return loadLogs();
  if (dashTab === "messaging") return loadMessaging();
  if (dashTab === "status") return loadStatus(force);
  if (dashTab === "pricing") return loadPricing();
  if (dashTab === "sales") return loadSales();
  loadOrders();
}

async function loadMaintenance() {
  const button = $("#maintenanceToggle");
  if (!button) return;
  button.disabled = false;                 // self-heal a stuck button
  delete button.dataset.armed;
  button.classList.remove("armed");
  const label = $("#emergLabel");
  const { ok, data } = await ajax("/api/admin/maintenance");
  if (!ok) {
    button.dataset.on = "false";
    if (label) label.textContent = "Site status unavailable";
    button.title = "Could not read the current site status. Press to turn the site OFF.";
    return;
  }
  button.dataset.on = data.on ? "true" : "false";
  // Action-first wording. The old label stated the state ("Site: LIVE (turn off)"),
  // which had to be read before you knew what pressing did, and it was clipped on a
  // phone. These say what the press will do, and stay short.
  if (label) label.textContent = data.on ? "Bring the site back ON" : "Take the site OFFLINE";
  button.title = data.on
    ? "The store is OFF. Press to let customers buy again."
    : "The store is LIVE. Press to stop new purchases. This admin panel stays available.";
}

/* Two-step confirmation, drawn in the page, instead of window.confirm().
   A native confirm() is silently discarded by some in-app browsers (notably the
   WhatsApp and some Android WebViews), so the press looked like it did nothing at
   all. This always shows, needs no dialog permission, and states exactly what will
   happen. */
/* Set while any two-tap button is armed. The order poll checks it so an armed
   button is not destroyed by the 8-second table refresh. */
let ARMED_UNTIL = 0;
let lastSearch = null;
let ordSearchTimer = 0;

function askTwice(button, message, confirmLabel) {
  if (button.dataset.armed === "true") {
    delete button.dataset.armed;
    button.classList.remove("armed");
    return true;
  }
  button.dataset.armed = "true";
  button.classList.add("armed");
  /* The order-action buttons are plain text, while the header switches wrap their
     text in a <span>. Handle both, or the label never changes and the button looks
     like it did nothing. */
  const label = button.querySelector("span:last-child") || button;
  if (label !== button) button.dataset.originalLabel = label.textContent;
  else button.dataset.originalLabel = button.textContent;
  label.textContent = confirmLabel;
  /* Hold the order table still while a button is armed. The table re-renders every
     8 seconds, which would destroy the armed button between the first and second
     press and the tap would silently do nothing. */
  ARMED_UNTIL = Date.now() + 8000;
  const note = button.parentElement && button.parentElement.nextElementSibling;
  if (note && note.classList.contains("dim")) note.textContent = message;
  setTimeout(() => {
    if (button.dataset.armed !== "true") return;
    delete button.dataset.armed;
    button.classList.remove("armed");
    const l = button.querySelector("span:last-child") || button;
    if (button.dataset.originalLabel) l.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
    ARMED_UNTIL = 0;
  }, 8000);
  return false;
}

async function toggleMaintenance() {
  const button = $("#maintenanceToggle");
  /* Never stay disabled. A previous version set disabled=true, then awaited a
     request without a finally, so ONE failed request left the button permanently
     dead: every later press returned early and the owner could not bring the
     site back online at all. Un-disable defensively on every entry. */
  if (!button) return;
  button.disabled = false;
  const turningOn = button.dataset.on !== "true";
  const ok = askTwice(
    button,
    turningOn
      ? "Press again to confirm. Customers will not be able to buy."
      : "Press again to confirm. Customers will be able to buy again.",
    turningOn ? "Tap again to confirm" : "Tap again to bring the site ON",
  );
  if (!ok) return;
  const label = $("#emergLabel");
  if (label) label.textContent = "Saving…";
  try {
    const { ok: done, data } = await ajax("/api/admin/maintenance", { method: "PUT", body: JSON.stringify({ on: turningOn }) });
    if (!done) { toast(data.error || "Could not change site status", true); await loadMaintenance(); return; }
    toast(turningOn ? "Store is OFF. New purchases are paused." : "Store is live again.");
  } catch (e) {
    toast("Could not reach the server. Check your connection and press again.", true);
  } finally {
    button.disabled = false;      // always, whatever happened
    delete button.dataset.armed;
    button.classList.remove("armed");
    delete button.dataset.originalLabel;
  }
  await loadMaintenance();
}

/* ---------- sales ---------- */
async function loadSales() {
  const view = $("#salesView");
  const { ok, data } = await ajax("/api/admin/sales");
  if (!ok) { view.innerHTML = `<div class="feature"><h3>Could not load sales</h3><p class="dim">${esc(data.error || "unknown error")}</p></div>`; toast(data.error || "Failed", true); return; }
  const t = data.totals;
  const p = data.period;
  const s = data.supplier || {};
  const card = (k, v, sub) => `<div class="feature"><h3>${esc(k)}</h3><p style="font-size:22px;font-weight:800;color:var(--ink)">${esc(v)}</p>${sub ? `<p class="dim">${esc(sub)}</p>` : ""}</div>`;
  const supplierState = s.error ? "UNREACHABLE" : s.catalogError ? "CATALOG ERROR" : s.low ? "BALANCE LOW" : "OK";
  const supplierTone = s.error || s.catalogError ? "#b91c1c" : s.low ? "#b45309" : "#15803d";
  const supplierSummary = s.error
    ? "Could not reach iDATA: " + esc(s.error) + ". You may not be able to deliver. Do not accept customer money until this clears."
    : s.catalogError
      ? "iDATA balance is readable, but the bundle catalog failed: " + esc(s.catalogError) + ". The number of servable orders is unknown."
      : `${esc(s.ordersLeft)} more order${s.ordersLeft === 1 ? "" : "s"} can be served from this balance (cheapest bundle GHS ${esc(fmt(s.cheapestCost))}). ${esc(s.bundles)} bundles in the catalog.`;
  const supplierCard = `
    <div class="feature" style="grid-column:1/-1;border-left:4px solid ${supplierTone}">
      <h3>Supplier (iDATA): ${supplierState}</h3>
      <p style="font-size:22px;font-weight:800;color:var(--ink)">${s.balance === null || s.balance === undefined ? "unknown" : "GHS " + esc(fmt(s.balance))}</p>
      <p class="dim">${supplierSummary}</p>
      <p class="dim" style="margin-top:6px">Keep this balance low and top up often. Money sitting with a supplier is the one thing you cannot control. A low balance is the warning that a delivery is about to fail.</p>
      <div class="pay-actions" style="margin-top:10px"><button type="button" class="btn btn-ghost" id="supCheck">Check supplier now</button></div>
    </div>`;
  view.innerHTML = `
    <div class="grid-features">
      ${card("Total money in", `GHS ${fmt(t.revenue)}`, `today GHS ${fmt(p.paid.today)} · this month GHS ${fmt(p.paid.month)}`)}
      ${card("Total profit", `GHS ${fmt(t.profit)}`, `after the GHS ${fmt(t.cost)} you paid iDATA`)}
      ${supplierCard}
      ${card("Orders paid", t.paidOrders, `${t.delivered} delivered · ${t.refunded} refunded`)}
      ${card("Delivered bundles", t.delivered, `today GHS ${fmt(p.delivered.today)}`)}
      ${card("Customer wallets", `GHS ${fmt(t.walletBalance)}`, "unspent credit customers hold")}
      ${card("Top-ups approved", `GHS ${fmt(t.topupApproved)}`, `refunded out GHS ${fmt(t.refundedValue || 0)}`)}
    </div>
    <div class="feature" style="margin-top:16px;max-width:100%">
      <h3>What you sold</h3>
      <p class="dim">Count and money for every bundle. Profit is what you earned after paying iDATA.</p>
      <div style="overflow-x:auto;margin-top:12px"><table class="admin-table">
        <thead><tr><th>Bundle</th><th>Network</th><th>Orders</th><th>Delivered</th><th>Money in</th><th>Your cost</th><th>Profit</th></tr></thead>
        <tbody>${data.bundles.length ? data.bundles.map((b) => `<tr>
          <td><b>${esc(b.planName)}</b></td>
          <td>${esc(b.network)}</td>
          <td>${esc(b.orders)}</td>
          <td>${esc(b.delivered)}</td>
          <td>GHS ${esc(fmt(b.revenue))}</td>
          <td>GHS ${esc(fmt(b.cost))}</td>
          <td style="color:${b.profit >= 0 ? "#15803d" : "#b91c1c"};font-weight:700">GHS ${esc(fmt(b.profit))}</td>
        </tr>`).join("") : '<tr><td colspan="7">No paid orders yet.</td></tr>'}</tbody>
      </table></div>
      <p class="dim" id="salesCount" style="margin-top:10px"></p>
    </div>`;
  $("#salesCount").textContent = `${data.bundles.length} bundle${data.bundles.length === 1 ? "" : "s"} sold so far.`;
  const supCheck = $("#supCheck");
  if (supCheck) supCheck.addEventListener("click", async () => {
    supCheck.disabled = true; supCheck.textContent = "Checking…";
    const r = await ajax("/api/admin/supplier/check", { method: "POST" });
    if (!r.ok) { toast(r.data.error || "Check failed", true); supCheck.disabled = false; supCheck.textContent = "Check supplier now"; return; }
    toast(r.data.error ? "iDATA is not reachable. See the banner." : `iDATA balance: GHS ${fmt(r.data.balance)}`);
    await loadSales();
    await loadAlerts();
  });
  toast("");
}

/* ---------- pricing ---------- */
let PRICING = null;

async function loadPricing() {
  const view = $("#pricingView");
  const { ok, data } = await ajax("/api/admin/pricing");
  if (!ok) { view.innerHTML = `<div class="feature"><h3>Could not load pricing</h3><p class="dim">${esc(data.error || "unknown error")}</p></div>`; toast(data.error || "Failed", true); return; }
  PRICING = data;
  const s = data.settings;
  const promo = s.promo || {};
  const promoState = data.promoLive ? "RUNNING" : data.promoExpired ? "EXPIRED" : "off";
  const promoBadge = data.promoLive
    ? `<span class="badge delivered">RUNNING${esc(promo.label ? ` (${promo.label})` : "")}</span>`
    : data.promoExpired ? `<span class="badge pending">EXPIRED${esc(promo.endsAt ? ` ${new Date(promo.endsAt).toLocaleString()}` : "")}</span>` : `<span class="badge" style="background:#f1f5f9;color:#475569">OFF</span>`;

  view.innerHTML = `
    <div class="feature" style="max-width:820px">
      <h3>Pricing control</h3>
      <p class="dim">Leave a bundle on <b>Auto</b> and its price follows the supplier's live cost. Pin a bundle to a fixed price to override it. Promos stack on top and expire on their own.</p>
    </div>

    <div class="feature" style="max-width:820px;margin-top:14px">
      <h3>Default markup</h3>
      <div class="field"><label for="pmMarkup">Member markup (% added to supplier cost)</label><input id="pmMarkup" type="number" step="0.5" min="-90" max="1000" value="${esc(s.markupPercent)}" /></div>
      <div class="field"><label for="pmGuest">Guest markup (% added to supplier cost)</label><input id="pmGuest" type="number" step="0.5" min="-90" max="1000" value="${esc(s.guestMarkupPercent)}" /></div>
      <div class="field"><label for="pmFloor">Margin floor: never sell below cost + (%)</label><input id="pmFloor" type="number" step="0.5" min="0" max="1000" value="${esc(s.minMarginPercent)}" /><p class="dim" style="margin-top:6px">A safety net: promos and auto prices can never push a bundle below this. Leave 0 for none. Set 30 if you want a guaranteed 30% gain on every sale.</p></div>
      <div class="pay-actions"><button type="button" class="btn btn-primary" id="pmSave">Save markup</button></div>
    </div>

    <div class="feature" style="max-width:820px;margin-top:14px">
      <h3>Promo ${promoBadge}</h3>
      <div class="field"><label class="wrap-check"><input type="checkbox" id="ppActive"${promo.active ? " checked" : ""} /> Promo is ON</label></div>
      <div class="field"><label for="ppPercent">Discount (%)</label><input id="ppPercent" type="number" step="1" min="0" max="100" value="${esc(promo.percent || 0)}" /></div>
      <div class="field"><label for="ppLabel">Label shown to customers (optional)</label><input id="ppLabel" maxlength="60" value="${esc(promo.label || "")}" placeholder="e.g. Weekend 20% off" /></div>
      <div class="field"><label for="ppEnds">Auto-turn-off (optional)</label><input id="ppEnds" type="datetime-local" value="${esc(promo.endsAt ? new Date(promo.endsAt).toISOString().slice(0, 16) : "")}" /><p class="dim" style="margin-top:6px">Leave blank to run until you switch it off.</p></div>
      <fieldset style="border:1px solid var(--line);border-radius:12px;padding:12px"><legend class="dim">Applies to</legend>${["mtn", "telecel", "airteltigo"].map((n) => `<label class="wrap-check" style="display:inline-flex;margin-right:16px"><input type="checkbox" data-pnet="${n}"${(promo.networks || []).includes(n) ? " checked" : ""} /> ${n === "airteltigo" ? "AirtelTigo" : n[0].toUpperCase() + n.slice(1)}</label>`).join("")}</fieldset>
      <div class="pay-actions"><button type="button" class="btn btn-pay" id="ppSave">Save promo</button><button type="button" class="btn btn-ghost" id="ppOff">Turn promo off now</button></div>
    </div>

    <div class="feature" style="max-width:100%;margin-top:14px">
      <h3>Bundles</h3>
      <div class="field"><input id="prSearch" placeholder="Search bundle or network…" maxlength="40" /></div>
      <div style="overflow-x:auto"><table class="admin-table">
        <thead><tr><th>Bundle</th><th>Your cost</th><th>Member</th><th>Margin</th><th>Guest</th><th>Mode</th><th>Pin price</th></tr></thead>
        <tbody id="prRows"></tbody>
      </table></div>
      <p class="dim" id="prCount"></p>
    </div>`;

  const drawRows = () => {
    const q = ($("#prSearch").value || "").toLowerCase();
    const floorPct = Number(data.settings.minMarginPercent || 0);
    const rows = data.rows.filter((r) => !q || `${r.network} ${r.name}`.toLowerCase().includes(q));
    $("#prCount").textContent = `${rows.length} of ${data.rows.length} bundles`;
    $("#prRows").innerHTML = rows.map((r) => {
      const bad = r.marginPercent < 0;
      const thin = !bad && floorPct > 0 && r.marginPercent < floorPct - 0.01;
      const mColor = bad ? "color:#b91c1c;font-weight:700" : thin ? "color:#b45309;font-weight:700" : "";
      const mTitle = bad ? "Below cost (you would lose money)" : thin ? "Below your margin floor" : "";
      return `<tr data-row="${esc(r.id)}">
      <td><b>${esc(r.network)}</b> ${esc(r.name)}</td>
      <td>${esc(fmt(r.cost))}</td>
      <td><b>${esc(fmt(r.member))}</b>${r.floored ? ' <span class="badge pending" title="Raised to your margin floor">floor</span>' : ""}</td>
      <td style="${mColor}" title="${esc(mTitle)}">${esc(r.marginPercent)}%</td>
      <td>${esc(fmt(r.guest))}</td>
      <td>${r.source === "fixed" ? '<span class="badge delivered">Pinned</span>' : '<span class="badge" style="background:#f1f5f9;color:#475569">Auto</span>'}</td>
      <td><div class="pin-row"><input data-pin="${esc(r.id)}" type="number" step="0.01" min="0.01" placeholder="${esc(String(r.member))}" /><button type="button" class="buy-btn" data-pin-save="${esc(r.id)}">Pin</button><button type="button" class="buy-btn danger" data-pin-clear="${esc(r.id)}">Auto</button></div></td>
    </tr>`;
    }).join("");
  };
  drawRows();
  $("#prSearch").addEventListener("input", drawRows);

  $("#pmSave").addEventListener("click", async () => {
    const btn = $("#pmSave"); btn.disabled = true; btn.textContent = "Saving…";
    const r = await ajax("/api/admin/pricing", { method: "PUT", body: JSON.stringify({
      markupPercent: Number($("#pmMarkup").value),
      guestMarkupPercent: Number($("#pmGuest").value),
      minMarginPercent: Number($("#pmFloor").value),
    }) });
    btn.disabled = false; btn.textContent = "Save markup";
    if (!r.ok) return toast(r.data.error || "Failed", true);
    toast("Markup saved. All prices recalculated.");
    await loadPricing();
  });

  $("#ppSave").addEventListener("click", async () => {
    const btn = $("#ppSave"); btn.disabled = true; btn.textContent = "Saving…";
    const ends = $("#ppEnds").value;
    const r = await ajax("/api/admin/pricing", { method: "PUT", body: JSON.stringify({ promo: {
      active: $("#ppActive").checked,
      percent: Number($("#ppPercent").value),
      label: $("#ppLabel").value,
      networks: Array.from(document.querySelectorAll("[data-pnet]")).filter((c) => c.checked).map((c) => c.dataset.pnet),
      endsAt: ends ? new Date(ends).toISOString() : null,
    } }) });
    btn.disabled = false; btn.textContent = "Save promo";
    if (!r.ok) return toast(r.data.error || "Failed", true);
    toast("Promo saved");
    await loadPricing();
  });

  $("#ppOff").addEventListener("click", async () => {
    const r = await ajax("/api/admin/pricing", { method: "PUT", body: JSON.stringify({ promo: { active: false } }) });
    if (!r.ok) return toast(r.data.error || "Failed", true);
    toast("Promo off");
    await loadPricing();
  });

  document.querySelectorAll("[data-pin-save]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.pinSave;
    const inp = document.querySelector(`[data-pin="${CSS.escape(id)}"]`);
    const r = await ajax(`/api/admin/pricing/plan/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ fixed: inp.value }) });
    if (!r.ok) return toast(r.data.error || "Failed to pin", true);
    toast("Price pinned");
    await loadPricing();
  }));

  document.querySelectorAll("[data-pin-clear]").forEach((b) => b.addEventListener("click", async () => {
    const r = await ajax(`/api/admin/pricing/plan/${encodeURIComponent(b.dataset.pinClear)}`, { method: "PUT", body: JSON.stringify({ mode: "auto" }) });
    if (!r.ok) return toast(r.data.error || "Failed", true);
    toast("Back to auto pricing");
    await loadPricing();
  }));

  toast("");
}

const NET_LABEL = { mtn: "MTN", telecel: "Telecel", airteltigo: "AirtelTigo" };

async function loadSecretCard() {
  const box = $("#secretBody");
  if (!box) return;
  const { ok, data } = await ajax("/api/admin/credentials");
  if (!ok) { box.innerHTML = `<p class="dim">Could not load: ${esc(data.error || "unknown error")}</p>`; return; }
  if (!data.canWrite) {
    box.innerHTML = `<p class="dim">The server's secret file is not writable by the service, so keys cannot be changed from here yet. Ask the owner to update it on the server.</p>`;
    return;
  }
  const rows = (data.secrets || []).map((s) => `
    <div class="field" style="margin:14px 0 6px">
      <label for="sec_${esc(s.key)}">${esc(s.label)}</label>
      <input id="sec_${esc(s.key)}" type="password" autocomplete="off" spellcheck="false"
             placeholder="${s.set ? `Set (ends ${esc(s.last4)}) — paste a new one to replace` : "Not set — paste the key"}" />
      <p class="dim" style="margin:6px 0 0">${s.set
        ? `Currently set, ending <b>${esc(s.last4)}</b>. Leave blank to keep it.`
        : "Not set yet."}</p>
    </div>`).join("");
  box.innerHTML = `${rows}
    <div class="field" style="margin-top:16px">
      <label for="secPass">Your admin password (to confirm)</label>
      <input id="secPass" type="password" autocomplete="off" placeholder="Your admin password" />
    </div>
    <div class="pay-actions" style="margin-top:14px">
      <button type="button" class="btn btn-primary" id="secSave">Save keys</button>
    </div>
    <p class="dim" id="secOut" style="margin-top:12px"></p>`;
  $("#secSave").addEventListener("click", saveSecrets);
}

async function saveSecrets() {
  const btn = $("#secSave"), out = $("#secOut");
  const pass = $("#secPass").value;
  if (!pass) { out.textContent = "Enter your admin password to confirm."; toast("Enter your admin password to confirm", true); return; }
  const body = { current: pass };
  let any = false;
  document.querySelectorAll("#secretBody input[id^='sec_']").forEach((i) => {
    if (i.id === "secPass") return;
    const k = i.id.replace(/^sec_/, "");
    if (i.value.trim()) { body[k] = i.value.trim(); any = true; }
  });
  if (!any) { out.textContent = "Paste a new key first. Blank boxes are left unchanged."; return; }
  btn.disabled = true; btn.textContent = "Saving and testing…";
  const r = await ajax("/api/admin/credentials", { method: "PUT", body: JSON.stringify(body) });
  btn.disabled = false; btn.textContent = "Save keys";
  if (!r.ok) {
    out.textContent = r.data.error || "Failed to save";
    toast(r.data.error || "Failed to save", true);
    return;
  }
  statusDirty = false;
  toast("Keys updated and in use now");
  await loadSecretCard();
}

async function loadAutoApprove() {
  const button = $("#autoApproveToggle");
  if (!button) return;
  button.disabled = false;                 // self-heal a stuck button
  delete button.dataset.armed;
  button.classList.remove("armed");
  const label = $("#autoApproveLabel");
  const note = $("#autoApproveNote");
  const { ok, data } = await ajax("/api/admin/autoapprove");
  if (!ok) {
    button.dataset.on = "false";
    if (label) label.textContent = "Automatic approval: OFF";
    if (note) note.textContent = "Could not read the current setting. It is treated as OFF, so nothing is sent to the supplier without you.";
    return;
  }
  button.dataset.on = data.on ? "true" : "false";
  if (label) label.textContent = data.on ? "Automatic approval is ON" : "Automatic approval is OFF";
  if (note) {
    note.textContent = data.on
      ? "Card payments are sent to the supplier automatically, one time each, with no retry. Turn it OFF to approve every order yourself."
      : "You approve every order by hand. Paid orders wait in the Orders tab until you press Process, and nothing reaches the supplier until you do.";
  }
  button.title = data.on
    ? "Press to stop sending automatically. Orders will wait for you."
    : "Press to send card payments to the supplier automatically.";
}

async function toggleAutoApprove() {
  const button = $("#autoApproveToggle");
  if (!button) return;
  button.disabled = false;      // never stay dead, see toggleMaintenance
  const on = button.dataset.on !== "true";
  const ok = askTwice(
    button,
    on
      ? "Press again to confirm. Card payments will be sent to the supplier automatically, once each, with no retry."
      : "Press again to confirm. Every order will wait for you to press Process.",
    on ? "Tap again to confirm" : "Tap again to confirm",
  );
  if (!ok) return;
  const label = $("#autoApproveLabel");
  if (label) label.textContent = "Saving…";
  try {
    const { ok: done, data } = await ajax("/api/admin/autoapprove", { method: "PUT", body: JSON.stringify({ on }) });
    if (!done) { toast(data.error || "Could not change the setting", true); await loadAutoApprove(); return; }
    toast(on ? "Automatic approval is ON" : "Automatic approval is OFF");
  } catch (e) {
    toast("Could not reach the server. Check your connection and press again.", true);
  } finally {
    button.disabled = false;
    delete button.dataset.armed;
    button.classList.remove("armed");
    delete button.dataset.originalLabel;
  }
  await loadAutoApprove();
}

async function loadStatus(force) {
  const view = $("#statusView");
  // Never re-render over unsaved edits unless the owner explicitly refreshes.
  if (statusDirty && !force) return;
  const token = ++statusToken;
  const [stRes, noRes] = await Promise.all([
    ajax("/api/network-status"),
    ajax("/api/admin/notice").catch(() => ({ ok: false, data: { notice: { active: false, level: "info", title: "", message: "" } } })),
  ]);
  // A newer load started, or the owner began typing while we were waiting:
  // either way, do not replace the form they are working in.
  if (token !== statusToken) return;
  if (statusDirty && !force) return;
  if (!stRes.ok) { view.innerHTML = `<div class="feature"><h3>Could not load</h3><p class="dim">${esc(stRes.data.error || "unknown error")}</p></div>`; toast(stRes.data.error || "Failed to load", true); return; }
  const st = stRes.data || {};
  const n = (noRes.ok && noRes.data && noRes.data.notice) || { active: false, level: "info", title: "", message: "", updatedAt: null };
  const opt = (cur) => ["normal", "delayed", "down"]
    .map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${v === "normal" ? "Normal" : v === "delayed" ? "Delayed" : "Down"}</option>`).join("");
  const lvlOpt = (cur) => [
    ["info", "ℹ️ Info: general update"],
    ["warning", "⚠️ Warning: delays, slow network"],
    ["critical", "🚨 Critical: outage, orders paused"],
  ].map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
  view.innerHTML = `
    <div class="feature" style="max-width:700px">
      <h3>Notice board: tell customers what is happening</h3>
      <p class="dim">Anything you publish here appears at the top of every buyer page (home, MTN, Telecel, AirtelTigo and the account page) within seconds. Use it when a network is down, orders are paused, or you need to warn buyers. Customers only ever see the title, message and colour you choose. Nothing internal.</p>
      <div class="field"><label for="nbLevel">How urgent is it?</label><select id="nbLevel">${lvlOpt(n.level || "info")}</select></div>
      <div class="field"><label for="nbTitle">Headline (max 80 chars)</label><input id="nbTitle" maxlength="80" value="${esc(n.title || "")}" placeholder="e.g. MTN data is not delivering right now" /></div>
      <div class="field"><label for="nbMsg">Message to customers (max 300 chars)</label><textarea id="nbMsg" rows="3" maxlength="300" placeholder="e.g. MTN is having network problems. Please do not order MTN data for now. We will update here when it is fixed.">${esc(n.message || "")}</textarea></div>
      <div class="quick-presets" style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px">
        <button type="button" class="btn btn-ghost" data-preset="down">Network down</button>
        <button type="button" class="btn btn-ghost" data-preset="slow">Deliveries slow</button>
        <button type="button" class="btn btn-ghost" data-preset="paused">Orders paused</button>
        <button type="button" class="btn btn-ghost" data-preset="fixed">All fixed</button>
      </div>
      <label class="field" style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><input type="checkbox" id="nbActive" ${n.active ? "checked" : ""} style="width:18px;height:18px" /> <span><b>Show this notice to customers</b><br><span class="dim">Untick and save to take the board down when the problem is over.</span></span></label>
      <div class="pay-actions">
        <button type="button" class="btn btn-primary" id="nbSave">Save &amp; publish</button>
        <button type="button" class="btn btn-ghost" id="nbClear">Clear board</button>
      </div>
      <p class="dim" id="nbOut" style="margin-top:12px">${n.updatedAt ? `Last change: ${esc(new Date(n.updatedAt).toLocaleString("en-GB"))}` : "Nothing published yet."}</p>
    </div>
    <div class="feature" style="max-width:700px">
      <h3>Network delivery status</h3>
      <p class="dim">This shows on the storefront. If a network is slow, say so here instead of promising fast delivery you cannot control. Our supplier can be hours late.</p>
      <table class="admin-table" style="margin:14px 0">
        <tbody>
          ${Object.keys(NET_LABEL).map((k) => `<tr><td><b>${NET_LABEL[k]}</b></td><td><select data-net="${k}">${opt(st[k] || "normal")}</select></td></tr>`).join("")}
        </tbody>
      </table>
      <div class="field"><label for="stMsg">Extra notice shown to customers (optional)</label><input id="stMsg" maxlength="200" value="${esc(st.message || "")}" placeholder="e.g. MTN is queuing orders. They will still arrive." /></div>
      <div class="pay-actions"><button type="button" class="btn btn-primary" id="stSave">Save status</button></div>
      <p class="dim" id="stOut" style="margin-top:12px"></p>
    </div>`;

  // quick presets fill the notice form so the owner can post in seconds
  const PRESETS = {
    down:   { level: "critical", title: "Network problem: orders may not deliver", message: "A network is having problems right now. Please do not order until we update this notice. Any order already paid for is not lost. It will be delivered when the network recovers." },
    slow:   { level: "warning",  title: "Deliveries are slower than usual", message: "Data is still being delivered, but some orders are taking longer than normal. Please allow more time, and thank you for your patience." },
    paused: { level: "critical", title: "New orders are temporarily paused", message: "We have paused new orders while we sort things out. Our shop is still open on WhatsApp if you need data urgently." },
    fixed:  { level: "info",     title: "Everything is back to normal", message: "The network problem is over and deliveries are running normally again. Thank you for your patience." },
  };
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
    const p = PRESETS[b.dataset.preset]; if (!p) return;
    $("#nbLevel").value = p.level;
    $("#nbTitle").value = p.title;
    $("#nbMsg").value = p.message;
    toast("Template filled in. Review it, then publish.");
  }));

  // Any edit marks the form dirty so the 30s auto-refresh cannot discard it.
  view.querySelectorAll("input, select, textarea").forEach((f) => {
    f.addEventListener("input", () => { statusDirty = true; });
    f.addEventListener("change", () => { statusDirty = true; });
  });
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { statusDirty = true; }));

  /* Automatic approval: the owner's switch on whether the site ever spends the
     supplier balance without a press. Appended with the secrets card so both
     money controls sit together at the top of the Status tab. */
  view.insertAdjacentHTML("beforeend", `
    <div class="feature" style="max-width:700px">
      <h3>Automatic approval</h3>
      <p class="dim">Whether a paid order is sent to the supplier by itself, or waits for you. When it is off, a customer can still pay, the money is recorded, and the order waits in the Orders tab until you press Process. Nothing reaches the supplier without you.</p>
      <div style="margin:14px 0">
        <button type="button" class="autoapprove" id="autoApproveToggle" data-on="false">
          <span class="dot"></span><span id="autoApproveLabel">Automatic approval: OFF</span>
        </button>
      </div>
      <p class="dim" id="autoApproveNote" style="margin:0"></p>
    </div>`);
  $("#autoApproveToggle").addEventListener("click", toggleAutoApprove);
  loadAutoApprove();

  /* Supplier & payment keys. Appended after the main template so it always lands,
     and fetched on its own so it can never block the notice board. Marked dirty
     like the other fields so a 30s refresh cannot wipe a half-pasted key. */
  view.insertAdjacentHTML("beforeend", `
    <div class="feature" id="secretCard" style="max-width:700px">
      <h3>Supplier &amp; payment keys</h3>
      <p class="dim">Create a new key in iDATA's own dashboard, then paste it here. It is saved straight to the server's secret file and used immediately, so a key never has to be sent to anyone else. A new supplier key is checked against iDATA before it is accepted. The stored value is never shown again, only its last 4 characters.</p>
      <div id="secretBody">Loading…</div>
    </div>`);
  view.querySelectorAll("#secretBody input").forEach((f) => {
    f.addEventListener("input", () => { statusDirty = true; });
  });
  loadSecretCard();

  const saveNotice = async (clear) => {
    const body = clear
      ? { active: false }
      : { active: $("#nbActive").checked, level: $("#nbLevel").value, title: $("#nbTitle").value, message: $("#nbMsg").value };
    const r = await ajax("/api/admin/notice", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) { $("#nbOut").textContent = r.data.error || "Failed to save"; toast(r.data.error || "Failed to save", true); return; }
    statusDirty = false;
    await loadStatus(true);
    // Confirm after the re-render, otherwise loadStatus's toast("") erases it.
    toast(clear ? "Notice board cleared. Customers no longer see a notice." : "Notice published. Customers can see it now.");
  };
  $("#nbSave").addEventListener("click", () => saveNotice(false));
  $("#nbClear").addEventListener("click", () => saveNotice(true));

  $("#stSave").addEventListener("click", async () => {
    const btn = $("#stSave"); btn.disabled = true; btn.textContent = "Saving…";
    const body = { message: $("#stMsg").value };
    document.querySelectorAll("[data-net]").forEach((s) => { body[s.dataset.net] = s.value; });
    const r = await ajax("/api/admin/network-status", { method: "POST", body: JSON.stringify(body) });
    btn.disabled = false; btn.textContent = "Save status";
    if (!r.ok) { toast(r.data.error || "Failed to save", true); return; }
    statusDirty = false;
    await loadStatus(true);
    toast("Status updated. Storefront refreshed.");
  });
  toast("");
}

async function init() {
  $("#lShow").addEventListener("change", () => {
    const p = $("#lPass");
    p.type = p.type === "password" ? "text" : "password";
  });
  const submit = async () => {
    const user = $("#lUser").value.trim();
    const pass = $("#lPass").value;
    if (!user || !pass) { $("#lErr").textContent = "Enter your username and password."; return; }
    const btn = $("#lGo");
    btn.disabled = true; btn.textContent = "Signing in…"; $("#lErr").textContent = "";
    const { ok, data } = await ajax("/api/admin/login", { method: "POST", body: JSON.stringify({ user, pass }) });
    btn.disabled = false; btn.textContent = "Sign in";
    if (!ok) { $("#lErr").textContent = data.error || "Sign in failed."; return; }
    $("#lUser").value = ""; $("#lPass").value = "";
    await startDash();
  };
  $("#lGo").addEventListener("click", submit);
  $("#lPass").addEventListener("keydown", (e) => e.key === "Enter" && submit());
  $("#adminLogout").addEventListener("click", async () => {
    await ajax("/api/admin/logout", { method: "POST" });
    location.reload();
  });
  $("#adminRefresh").addEventListener("click", () => { statusDirty = false; loadActive(true); loadAlerts(); loadMaintenance(); });
  $("#maintenanceToggle").addEventListener("click", toggleMaintenance);
  const alertClear = $("#alertClear");
  if (alertClear) alertClear.addEventListener("click", async () => { await ajax("/api/admin/alerts/seen", { method: "POST" }); await loadAlerts(); });
  const pwToggle = $("#pwToggle"); const pwPanel = $("#pwPanel");
  if (pwToggle && pwPanel) {
    pwToggle.addEventListener("click", () => {
      pwPanel.hidden = !pwPanel.hidden;
      if (!pwPanel.hidden) $("#pwCur").focus();
    });
    $("#pwSave").addEventListener("click", async () => {
      const cur = $("#pwCur").value, a = $("#pwNew").value, b = $("#pwNew2").value;
      const msg = $("#pwMsg");
      if (a !== b) { msg.textContent = "The two new passwords do not match."; msg.style.color = "#b91c1c"; return; }
      if (a.length < 8) { msg.textContent = "New password must be at least 8 characters."; msg.style.color = "#b91c1c"; return; }
      const btn = $("#pwSave"); btn.disabled = true; btn.textContent = "Saving…"; msg.textContent = "";
      const r = await ajax("/api/admin/password", { method: "POST", body: JSON.stringify({ current: cur, next: a }) });
      btn.disabled = false; btn.textContent = "Save password";
      if (!r.ok) { msg.textContent = r.data.error || "Could not change the password."; msg.style.color = "#b91c1c"; return; }
      msg.textContent = "Password changed. Use the new one next time you sign in.";
      msg.style.color = "#15803d";
      $("#pwCur").value = ""; $("#pwNew").value = ""; $("#pwNew2").value = "";
    });
  }
  document.querySelectorAll(".admin-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  const { ok, status } = await ajax("/api/admin/session");
  if (ok) return startDash();
  if (status === 503) { show("login"); $("#lErr").textContent = "Admin isn't configured yet. The owner needs to set ADMIN_USER/ADMIN_PASS."; $("#lGo").hidden = true; return; }
  show("login");
}

async function loadAlerts() {
  const bar = $("#alertBar");
  const r = await ajax("/api/admin/alerts");
  if (!r.ok || !r.data.alerts || !r.data.alerts.length) { bar.hidden = true; return; }
  bar.hidden = false;
  // Group repeats of the same message so one problem is one line, not eight.
  const grouped = new Map();
  r.data.alerts.forEach((a) => {
    const k = a.msg;
    const g = grouped.get(k);
    // A row can already carry a repeat count, so add that, not just 1.
    if (g) { g.count += Number(a.count) || 1; if (a.t > g.t) g.t = a.t; }
    else grouped.set(k, { msg: a.msg, t: a.t, type: a.type, count: Number(a.count) || 1 });
  });
  const rows = [...grouped.values()].slice(0, 6);
  $("#alertList").innerHTML = rows.map((a) => `<li class="${a.type === "security" ? "sec" : ""}">${esc(new Date(a.t).toLocaleString())} — ${esc(a.msg)}${a.count > 1 ? ` <b>(${a.count} times)</b>` : ""}</li>`).join("");
  const hidden = grouped.size - rows.length;
  if (hidden > 0) $("#alertList").innerHTML += `<li class="dim">+ ${hidden} more older alert${hidden > 1 ? "s" : ""}</li>`;
}

async function startDash() {
  show("dash");
  await Promise.all([loadActive(), loadAlerts(), loadMaintenance()]);
  clearInterval(timer);
  // Skip the silent refresh while the owner has a field focused, so nothing they
  // are typing can be swapped out from under them. Alerts still refresh.
  timer = setInterval(() => { if (!ownerIsEditing()) loadActive(); loadAlerts(); }, 30000);
  startOrderPoll();
  const cn = $("#ordCheckNow");
  if (cn) cn.addEventListener("click", () => pollOrders());
}

async function loadOrders() {
  const { ok, data } = await ajax("/api/admin/summary");
  if (!ok) {
    if (data.error === "Admin login required." || data.error === "Session expired. Login again.") { location.reload(); return; }
    toast(data.error || "Failed to load", true);
    return;
  }
  $("#stats").innerHTML = [
    ["Total orders", data.totalOrders],
    ["Pending attention", data.pending],
    ["Delivered", data.delivered],
    ["Revenue (GHS)", data.revenue],
    ["Customers", data.customers],
    ["Top-ups pending", data.topupPending],
    ["iDATA wallet", data.wallet && data.wallet.balance != null ? `${data.wallet.balance} GHS` : "n/a"],
    ["API mode", data.config.apiMock ? "MOCK" : "LIVE"],
    ["Paystack", data.config.paystackOn ? "ON" : "off"],
    ["Supplier webhook", data.config.supplierWebhookSigned ? "signed" : "UNSIGNED"],
  ].map(([k, v]) => {
    const bad = v === "MOCK" || v === "UNSIGNED";
    return `<div class="feature"${bad ? ' style="border-color:#b91c1c"' : ""}><h3>${esc(k)}</h3><p style="font-size:22px;font-weight:800;color:${bad ? "#b91c1c" : "var(--ink)"}">${esc(v)}</p></div>`;
  }).join("");

  /* Two states that must never be quiet, because both look like normal operation
     from the outside:
       MOCK  — orders are "delivered" by a stub. Nothing reaches a customer.
       UNSIGNED webhook — iDATA's delivery updates are refused, so statuses only move
       when the owner moves them.
     Neither is fatal, and both are invisible in the order list otherwise. */
  const warn = [];
  if (data.config.apiMock) warn.push("This server is in MOCK mode: bundles are not really delivered and no supplier is charged. Set IDATAGH_USE_MOCK=0 with a real API key to sell.");
  if (!data.config.supplierWebhookSigned) warn.push("IDATAGH_WEBHOOK_SECRET is not set, so delivery updates from the supplier are refused. Order statuses will not change on their own — the reconciler and manual status control still work. Set it in the Credentials tab.");
  const warnBox = $("#cfgWarn");
  if (warnBox) {
    warnBox.hidden = !warn.length;
    warnBox.innerHTML = warn.map((w) => `<p style="margin:4px 0">${esc(w)}</p>`).join("");
  }

  // One place decides what the owner can do with an order, so a guest order that
  // paid by MoMo can actually be approved instead of only having "Process".
  window.__pdhOrders = data.orders || [];
  // The first full load is the baseline, so coming back to the dashboard does not
  // light up every order already known. A flag is used rather than testing for an
  // empty set, because "no orders yet" is a real state and must not swallow the
  // first genuinely new order.
  if (!ordersSeeded) { (data.orders || []).forEach((o) => seenOrderIds.add(o.id)); ordersSeeded = true; }
  renderOrderRows();
  renderOrderLive();
  toast("");
}

// Rendering the rows is separate from loading them, so typing in the search box
// re-draws the table instantly instead of calling the API (which also asks the
// supplier for the wallet balance) on every keystroke.
const orderWho = (o) => (o.source === "wallet" ? "Wallet order" : o.userId ? "Member" : "Guest");

/* Every reference that identifies this order, each labelled, because the Paystack
   reference and the supplier reference are different numbers for the same order
   and confusing them is how a refund or a supplier query goes to the wrong place. */
const orderRefs = (o) => {
  const line = (label, val) => `<div class="ref-line"><span class="ref-label">${esc(label)}</span><span class="ref-code">${esc(val)}</span></div>`;
  const out = [];
  if (o.paystackRef) out.push(line("Paystack", o.paystackRef));
  if (o.providerRef) out.push(line("Supplier", o.providerRef));
  if (o.trackCode) out.push(line("Buyer code", o.trackCode));
  if (o.refundRef) out.push(line(o.refundRef === "paystack" || String(o.refundRef).indexOf("RFN") === 0 ? "Refund" : "Refund ref", o.refundRef));
  if (!out.length) out.push('<span class="dim">No card payment</span>');
  return out.join("");
};

/* ---- what the owner has to do, in one place ----
   This is the client-side twin of refundStateOf() on the server. Both must agree,
   or the admin offers an action the server will refuse, which is exactly the dead
   button that cost a sale on 2026-09-29. The server is always the final word: it
   re-checks every one of these before it acts.

   rank 0 = needs you   rank 1 = waiting on the network   rank 2 = done */
function orderTriage(o) {
  if (o.status === "delivered") return { rank: 2, flag: null };
  if (o.status === "cancelled" || o.status === "refunded") return { rank: 2, flag: null };
  /* A send claim with no supplier reference is the one state nobody else will ever
     report: the customer may have nothing, and only the owner can ask the supplier
     and decide. It outranks everything except a refund already owed. */
  const claimed = !o.providerRef && Boolean(o.sendClaimedAt || o.autoSendTriedAt);
  const nothingSent = !o.providerRef && !(Number(o.sendAttempts) > 0) && !o.autoSendTriedAt && !o.sendClaimedAt;
  if (o.refundOwed || o.refundStatus === "failed") return { rank: 0, flag: "refund" };
  if (claimed && ["paid", "processing", "failed"].includes(o.status)) return { rank: 0, flag: "claim" };
  if (o.status === "processing" && nothingSent) return { rank: 0, flag: "stuck" };
  if (o.status === "paid" && nothingSent) return { rank: 0, flag: "send" };
  if (o.status === "pending" || o.status === "pending_payment") return { rank: 0, flag: "send" };
  if (o.status === "failed") return { rank: 0, flag: "send" };
  return { rank: 1, flag: null };
}

const TRIAGE_ROW = {
  refund: { cls: "t-refund",  text: "Refund owed" },
  claim:  { cls: "t-stuck",   text: "Send unconfirmed" },
  stuck:  { cls: "t-stuck",   text: "Paid, never sent" },
  send:   { cls: "t-send",    text: "Needs you" },
};

let ordSortKey = "triage";

function renderOrderRows() {
  const tb = $("#tbodyOrders");
  if (!tb) return;
  const all = window.__pdhOrders || [];
  const orderActions = (o) => {
    const id = esc(o.id);
    const b = (act, label, cls) => `<button class="buy-btn ${cls || ""}" data-id="${id}" data-act="${act}">${label}</button>`;
    const money = `${esc(o.currency || "GHS")} ${esc(o.sell != null ? Number(o.sell).toFixed(2) : "0.00")}`;

    /* A refund is offered whenever OUR record says money was taken and nothing was
       ever sent, because that is the state where a customer is out of pocket. The
       label carries the amount, so the owner is never guessing what a press will do. */
    const canRefund = !["delivered", "cancelled", "refunded"].includes(o.status)
      && (o.paystackRef || o.verifiedAt || o.refundOwed || o.refundStatus === "failed")
      && o.refundStatus !== "refunded" && o.refundStatus !== "pending";
    const refundBtn = canRefund
      ? b("refund", `Refund ${money}`, o.source === "wallet" ? "primary" : "danger")
      : "";

    /* Whether an order may be sent is decided by the SERVER (sendBlockedReason), and
       sent to the dashboard as `sendable`, so the button the owner sees is always the
       button the server will honour. Sending it ourselves here is how a button ends up
       offering an action that is refused — or worse, before claims existed, one that
       quietly bought the bundle twice.
       When it is not sendable and nothing has come back from the supplier, the owner
       gets the explicit release button instead, which asks who at iDATA confirmed the
       order never arrived and records the answer on the order. */
    const claimed = !o.providerRef && !o.sendable
      && Boolean(o.autoSendTriedAt || o.sendClaimedAt || Number(o.sendAttempts) > 0);
    const releaseNote = o.sendClaimReleasedAt
      ? `<div class="act-note">A previous send was released by you${o.sendClaimConfirmedBy ? ` (supplier: ${esc(o.sendClaimConfirmedBy)})` : ""}. This next send happens once, with no automatic retry.</div>`
      : "";
    const releaseBtn = (cls) => b("releaseclaim", "Allow one more try", cls || "danger");
    const sendOrRelease = (cls) => (claimed ? releaseBtn(cls) : b("process", "Send to supplier", cls));

    switch (o.status) {
      /* A pending order that somehow already carries a send claim offers the release
         instead of Mark paid, so the owner is never shown a button that bounces. */
      case "pending":
        return claimed
          ? `<div class="act-main">${releaseBtn()}</div><div class="act-alt">${b("cancel", "Cancel", "danger")}</div>`
          : `<div class="act-main">${b("markpaid", "Mark paid &amp; send", "primary")}</div><div class="act-alt">${b("cancel", "Cancel", "danger")}</div>`;
      case "pending_payment":
        return claimed
          ? `<div class="act-note">A send was already attempted for this order.</div><div class="act-main">${releaseBtn()}</div><div class="act-alt">${b("cancel", "Cancel", "danger")}</div>`
          : `<div class="act-note">Card payment not confirmed. If they paid by MoMo:</div><div class="act-main">${b("markpaid", "Mark paid &amp; send", "primary")}</div><div class="act-alt">${b("cancel", "Cancel", "danger")}</div>`;
      case "paid":
        /* Only a send that is genuinely running right now says "Sending…". A claim
           left behind by a crash says so instead, and offers the way out. */
        if (o.sending) return `<span class="act-note">Sending to the supplier…</span>`;
        if (claimed) return `${releaseNote}<div class="act-main">${releaseBtn()}</div><div class="act-alt">${refundBtn || b("cancel", "Cancel", "danger")}</div>`;
        return `${releaseNote}<div class="act-main">${b("process", "Send to supplier", "primary")}</div>${refundBtn ? `<div class="act-alt">${refundBtn}</div>` : ""}`;
      case "processing":
        if (!o.providerRef) {
          return `${releaseNote}<div class="act-main">${sendOrRelease("danger")}</div><div class="act-alt">${refundBtn || b("cancel", "Cancel", "danger")}</div>`;
        }
        return `<span class="act-note">In progress at the network. Nothing to do.</span>`;
      case "failed":
        const retry = !o.providerRef ? `<div class="act-main">${sendOrRelease("primary")}</div>` : "";
        const back = o.source === "wallet" && !o.refundStatus ? b("refund", `Refund ${money}`, "primary") : refundBtn;
        return `${releaseNote}${retry}<div class="act-alt">${back || ""}</div>`;
      default:
        return o.refundStatus === "refunded" ? `<span class="act-ok">Refunded</span>` : "";
    }
  };

  const ordFilter = ($("#ordFilter") ? $("#ordFilter").value : "").trim().toLowerCase();
  const matchesFilter = (o) => !ordFilter || [o.id, o.paystackRef, o.providerRef, o.phone, o.planName, o.trackCode]
    .some((v) => v && String(v).toLowerCase().includes(ordFilter));

  const shown = all.filter(matchesFilter);
  const tri = new Map(shown.map((o) => [o.id, orderTriage(o)]));
  const searchNote = $("#ordSearchNote");
  if (searchNote) {
    searchNote.textContent = !ordFilter
      ? ""
      : lastSearch && lastSearch.term === ($("#ordFilter").value || "").trim()
        ? `${lastSearch.matched} match${lastSearch.matched === 1 ? "" : "es"} across all orders.`
        : "Searching all orders…";
  }
  const key = ordSortKey;
  const cmp = {
    triage: (a, b) => (tri.get(a.id).rank - tri.get(b.id).rank) || (new Date(b.created) - new Date(a.created)),
    order:  (a, b) => String(a.id).localeCompare(String(b.id)),
    plan:   (a, b) => String(a.planName).localeCompare(String(b.planName)) || (new Date(b.created) - new Date(a.created)),
    num:    (a, b) => String(a.phone).localeCompare(String(b.phone)) || (new Date(b.created) - new Date(a.created)),
    money:  (a, b) => (Number(b.sell) || 0) - (Number(a.sell) || 0),
    status: (a, b) => (tri.get(a.id).rank - tri.get(b.id).rank) || (new Date(b.created) - new Date(a.created)),
  }[key];
  shown.sort(cmp);

  /* The strip above the table answers "is there anything I must do, and how much
     money is sitting in it" without counting rows by hand. It is computed from the
     orders already in the browser, so it costs no extra request. */
  const strip = $("#ordTriage");
  if (strip) {
    const need = shown.filter((o) => tri.get(o.id).rank === 0);
    const owed = shown.filter((o) => tri.get(o.id).flag === "refund");
    const value = need.reduce((s, o) => s + (Number(o.sell) || 0), 0);
    const owedValue = owed.reduce((s, o) => s + (Number(o.sell) || 0), 0);
    strip.hidden = false;
    strip.innerHTML = [
      [`${need.length}`, "needs you"],
      [`${owed.length}`, owed.length === 1 ? "refund owed" : "refunds owed"],
      [`GHS ${value.toFixed(2)}`, "money in those orders"],
      [`GHS ${owedValue.toFixed(2)}`, "owed to customers"],
    ].map(([n, l]) => `<div class="triage-cell${l.indexOf("refund") === 0 || l.indexOf("owed") === 0 ? " triage-alert" : ""}"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("");
  }

  tb.innerHTML = shown.length ? shown.map((o) => {
    const t = tri.get(o.id);
    const flag = t.flag && TRIAGE_ROW[t.flag];
    const net = String(o.network || "").toLowerCase();
    const isNew = newOrderIds.has(o.id);
    return `
    <tr class="${isNew ? "is-new" : ""}${t.rank === 2 ? " ord-done" : ""}">
      <td class="ord-c-status" data-label="Status">
        <div class="st-badge st-${esc(o.status)}">${esc(orderStatusLabel(o))}</div>
        ${flag ? `<div class="st-flag ${flag.cls}">${esc(flag.text)}</div>` : ""}
        ${!flag && o.progress && o.progress.label ? `<div class="st-sub">${esc(o.progress.label)}</div>` : ""}
        ${o.providerMessage && o.status !== "failed" ? `<div class="st-sub">${esc(o.providerMessage)}</div>` : ""}
        ${o.error ? `<div class="st-err">${esc(o.error)}</div>` : ""}
      </td>
      <td class="ord-c-order" data-label="Order">
        <div class="mono">${esc(o.id)}${isNew ? ' <span class="new-pill">NEW</span>' : ""}</div>
        <div class="st-sub">${esc(orderWho(o))}</div>
        <div class="st-sub">${esc(new Date(o.created).toLocaleString())}</div>
      </td>
      <td class="ord-c-plan" data-label="Bundle">
        <div class="plan-name">${esc(o.planName)}</div>
        <div class="net-tag net-${esc(net)}">${esc(o.network)}</div>
      </td>
      <td class="ord-c-num" data-label="Number"><div class="mono">${esc(o.phone)}</div></td>
      <td class="ord-c-money" data-label="Price"><div class="money">${esc(o.currency || "GHS")} ${esc(o.sell != null ? Number(o.sell).toFixed(2) : "0.00")}</div></td>
      <td class="ord-c-refs" data-label="References"><div class="refs-wrap">${orderRefs(o)}</div></td>
      <td class="ord-c-act" data-label="Action">${orderActions(o)}</td>
    </tr>`;
  }).join("")
    : `<tr class="ord-empty"><td colspan="7">${all.length ? "No order matches that search." : "No orders yet."}</td></tr>`;

  document.querySelectorAll("#tblOrders .ord-sort").forEach((btn) => {
    btn.classList.toggle("sorted", btn.dataset.sort === ordSortKey);
    btn.setAttribute("aria-sort", btn.dataset.sort === ordSortKey ? "descending" : "none");
  });


  /* Confirmation is drawn IN THE PAGE, not with window.confirm().
     A native confirm() is silently DISCARDED by some in-app browsers, notably the
     WhatsApp WebView on Android: the button looked dead, no dialog appeared, and
     NO request was ever sent to the server. On 2026-09-29 that is how a paid
     AirtelTigo 10GB order sat unsent (sendAttempts 0, no log line at all) and the
     owner ended up buying the bundle by hand at the supplier.
     askTwice() cannot be swallowed: the first press arms the button and the
     second one acts. */
  const CONFIRM = {
    markpaid: "This sends the data and spends your supplier balance. Press again to confirm you received the payment.",
    cancel: "Cancel this order? Nothing will be sent. Press again to confirm.",
    refund: "Refund the customer? This returns real money. Press again to confirm.",
    process: "This sends the data and spends your supplier balance. Press again to send.",
  };

  /* Releasing a send claim is the one action that can lead to a second purchase, so
     it asks for the reason in writing first. Drawn in the page, because a native
     prompt() is discarded by the same in-app browsers that discard confirm() (see
     the note above), which would leave the owner with a button that does nothing. */
  const beginClaimRelease = (button, orderId) => {
    const cell = button.closest("td");
    if (!cell) return;
    cell.innerHTML = `
      <div class="act-note">Release the send claim? Only after iDATA confirms order <b>${esc(orderId)}</b> never reached them. It can then be sent once — it is never retried automatically.</div>
      <div class="act-main"><input class="rel-who" type="text" maxlength="120" placeholder="Who at iDATA confirmed?" aria-label="Who at iDATA confirmed the order never arrived" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px" /></div>
      <div class="act-alt"><button type="button" class="buy-btn primary rel-go">Release claim</button><button type="button" class="buy-btn rel-no">Cancel</button></div>`;
    const input = cell.querySelector(".rel-who");
    if (input) input.focus();
    /* Hold the polling refresh for as long as the form is open, on top of the fact
       that a focused input already pauses it. */
    ARMED_UNTIL = Date.now() + 120000;
    cell.querySelector(".rel-no").addEventListener("click", () => { ARMED_UNTIL = 0; renderOrderRows(); });
    cell.querySelector(".rel-go").addEventListener("click", async () => {
      const who = (input.value || "").trim();
      if (!who) { toast("Type who at iDATA confirmed the order never arrived.", true); input.focus(); return; }
      const r = await ajax(`/api/admin/orders/${encodeURIComponent(orderId)}/clear-send-claim`, {
        method: "POST",
        body: JSON.stringify({ confirmedBy: who }),
      });
      ARMED_UNTIL = 0;
      if (!r.ok) { toast(r.data.error || "Could not release the claim", true); return; }
      toast("Claim released. Press Send to supplier when ready — it will be sent once.");
      await loadOrders();
    });
  };

  document.querySelectorAll("#tbodyOrders button[data-id]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      const label = b.textContent;
      const ord = (window.__pdhOrders || []).find((x) => x.id === b.dataset.id) || {};
      if (act === "releaseclaim") return beginClaimRelease(b, b.dataset.id);
      /* Refunding something the supplier is still working on can pay the customer
         back for data they are about to receive. The server refuses it unless the
         request says the owner confirmed the loss, and this is the in-page way to
         say so: an explicit second press that spells out the consequence. */
      const inFlightRefund = act === "refund" && ["paid", "processing"].includes(ord.status) && !!ord.providerRef;
      if (act === "refund" && CONFIRM[act] && !askTwice(b,
        inFlightRefund
          ? `The supplier already has this order (${ord.providerRef}) and may still deliver it. Refund ONLY if iDATA has confirmed it will not be delivered, or the customer can end up with both the money and the data. Press again to refund anyway.`
          : CONFIRM[act],
        inFlightRefund ? "Tap again to refund anyway" : "Tap again to confirm")) return;
      if (CONFIRM[act] && act !== "refund" && !askTwice(b, CONFIRM[act], "Tap again to confirm")) return;
      b.disabled = true; b.textContent = "…";
      const url = act === "markpaid" ? "mark-paid" : act === "process" ? "status" : act;
      const body = act === "process" ? { status: "processing" } : {};
      if (inFlightRefund) body.confirmInFlight = true;
      try {
        const { ok, data: r } = await ajax(`/api/admin/orders/${b.dataset.id}/${url}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!ok) { toast(r.error || "Failed", true); return; }
        const done = act === "markpaid" ? "Payment confirmed. The data is being sent now."
          : act === "refund" ? (r.method === "wallet" ? "Refunded to the customer wallet" : r.method === "already-refunded" ? "This charge was already refunded at Paystack. Recorded it, and did not refund again." : "Refund sent to Paystack. The customer's card will be credited.")
          : act === "cancel" ? (r.refundOwed ? "Order cancelled. IMPORTANT: this customer had already paid, so refund them." : "Order cancelled")
          : "Sent to the customer";
        toast(done);
        if (act === "cancel" && r.refundOwed) loadOrders();
      } catch (e) {
        toast("Could not reach the server. Check your connection and press again.", true);
      } finally {
        /* Always restore the button, whatever happened. A stuck button means the
           owner cannot send an order at all, which costs the sale. */
        b.disabled = false;
        b.textContent = label;
        delete b.dataset.armed;
        b.classList.remove("armed");
        delete b.dataset.originalLabel;
      }
      await loadOrders();
    });
  });

  /* Sortable headers. Clicking a column re-orders the rows already in the
     browser, so sorting never triggers a request. */
  document.querySelectorAll("#tblOrders .ord-sort").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.sort;
      ordSortKey = ordSortKey === k ? "triage" : k;
      renderOrderRows();
    });
  });
}

// The fast poll. Only the order table is touched, the supplier is never called,
// and a newly arrived order is highlighted and counted so it cannot be missed.
async function pollOrders() {
  if (!canPollOrders()) return;
  /* With a search term in the box, ask the SERVER. The default poll only sees the
     sixty most recent orders, so searching locally would answer "no order matches
     that" for an order that does exist — the one thing an owner must never be told
     about a paid order. */
  const term = ($("#ordFilter") ? $("#ordFilter").value : "").trim();
  const { ok, data } = await ajax(`/api/admin/orders${term ? `?q=${encodeURIComponent(term)}&limit=200` : ""}`);
  if (!ok) return;                       // a 401 reloads the page by itself
  const list = Array.isArray(data.orders) ? data.orders : [];
  if (data.searching) lastSearch = { term, matched: Number(data.matched) || 0 };
  lastCheckedAt = new Date();
  // The baseline is taken from the first full load. If the poll somehow runs
  // before that, take it here so the next real order is still flagged.
  if (!ordersSeeded) { list.forEach((o) => seenOrderIds.add(o.id)); ordersSeeded = true; }
  const fresh = list.filter((o) => !seenOrderIds.has(o.id));
  if (fresh.length) {
    fresh.forEach((o) => { seenOrderIds.add(o.id); newOrderIds.add(o.id); });
    if (typeof Notification !== "undefined" && Notification.permission === "granted")
      new Notification("New order", { body: `${fresh.length} new order(s) waiting for approval.`, tag: "pdh-order" });
    // The highlight is a nudge, not a permanent state: it clears itself so the
    // table can never sit there with stale NEW badges.
    clearTimeout(newOrderFade);
    newOrderFade = setTimeout(() => { newOrderIds.clear(); renderOrderRows(); renderOrderLive(); }, 60000);
  }
  window.__pdhOrders = list;
  renderOrderRows();
  renderOrderLive();
}

function renderOrderLive() {
  const box = $(".order-live");
  if (!box) return;
  const n = newOrderIds.size;
  box.hidden = false;
  box.innerHTML = n
    ? `<strong>${n} new order${n > 1 ? "s" : ""} waiting.</strong> <button type="button" class="link-btn" id="ordSeen">Mark seen</button>`
    : `<span class="dim">Watching for new orders every 8 seconds. Last checked ${lastCheckedAt ? lastCheckedAt.toLocaleTimeString() : "just now"}.</span>`;
  const b = $("#ordSeen");
  if (b) b.addEventListener("click", () => { newOrderIds.clear(); renderOrderRows(); renderOrderLive(); });
  const t = $("#ordLiveToggle");
  if (t) { t.textContent = ordersLive ? "Pause" : "Resume"; t.setAttribute("aria-pressed", ordersLive ? "true" : "false"); }
}

function startOrderPoll() {
  clearInterval(orderPoll);
  orderPoll = setInterval(pollOrders, 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollOrders(); });
  const t = $("#ordLiveToggle");
  if (t) t.addEventListener("click", () => { ordersLive = !ordersLive; renderOrderLive(); if (ordersLive) pollOrders(); });
}

// Typing in the order search re-draws the table from the rows already loaded.
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "ordFilter") {
    renderOrderRows();                    // instant local filter, then the authoritative one
    clearTimeout(ordSearchTimer);
    ordSearchTimer = setTimeout(() => pollOrders(), 400);
  }
});

async function loadUsers() {
  const { ok, data } = await ajax("/api/admin/users");
  if (!ok) { toast(data.error || "Failed to load", true); return; }
  $("#usersView").innerHTML = data.users.length
    ? `<div style="overflow-x:auto"><table class="admin-table">
        <thead><tr><th>Name</th><th>Phone</th><th>Wallet</th><th>Member since</th></tr></thead>
        <tbody>${data.users.map((u) => `<tr>
          <td><b>${esc(u.name)}</b></td>
          <td>${esc(u.phone)}</td>
          <td>GHS ${esc(Number(u.wallet).toFixed(2))}</td>
          <td>${esc(new Date(u.created).toLocaleString())}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : '<p class="dim">No customer accounts yet.</p>';
  // Blocked numbers: a blocked number cannot buy a bundle in any channel. This
  // exists because of a real fraud incident on 2026-09-29 where one customer took
  // ~180 GHS of data for a single 19.30 payment by exploiting a supplier-send retry loop.
  $("#usersView").insertAdjacentHTML("beforeend", `
    <div class="feature" style="max-width:700px;margin-top:20px">
      <h3>Blocked numbers</h3>
      <p class="dim">A blocked number cannot buy data, in any channel (guest, wallet or bulk). Use this for anyone abusing the site. Blocking is reversible.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;margin:14px 0">
        <div class="field" style="margin:0"><label for="blockPhone">Number</label><input id="blockPhone" inputmode="numeric" placeholder="0550000000" /></div>
        <div class="field" style="margin:0"><label for="blockReason">Reason (optional)</label><input id="blockReason" maxlength="120" placeholder="e.g. abuse" /></div>
        <button id="blockSave" class="btn" style="height:44px">Block</button>
      </div>
      <div id="blockList"></div>
    </div>`);
  $("#blockSave").addEventListener("click", blockSubmit);
  await loadBlocked();
  toast("");
}

/* Blocked numbers. A blocked number cannot buy a bundle in any channel. This exists
   because of a real fraud incident on 2026-09-29 where one customer took ~180 GHS of
   data for a single 19.30 payment by exploiting an automatic supplier-send retry loop. */
function renderBlocked(list) {
  const rows = (list || []).map((b) => `<tr>
    <td><b>${esc(b.phone)}</b></td>
    <td>${esc(b.reason || "-")}</td>
    <td>${esc(new Date(b.at).toLocaleString())}</td>
    <td><button class="btn btn-sm" data-unblock="${esc(b.phone)}">Unblock</button></td>
  </tr>`).join("");
  $("#blockList").innerHTML = (list || []).length
    ? `<div style="overflow-x:auto"><table class="admin-table">
        <thead><tr><th>Number</th><th>Reason</th><th>Blocked</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : '<p class="dim">No numbers are blocked.</p>';
  $("#blockList").querySelectorAll("[data-unblock]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const phone = btn.getAttribute("data-unblock");
      const label = btn.textContent;
      /* In-page confirm, same reason as the order buttons: a native confirm() is
         silently discarded by some in-app browsers, making the button look dead. */
      if (!askTwice(btn, `Unblock ${phone}? They will be able to buy data again.`, "Tap again to unblock")) return;
      try {
        const r = await ajax(`/api/admin/blocked/${encodeURIComponent(phone)}`, { method: "DELETE" });
        if (!r.ok) { toast(r.data.error || "Could not unblock", true); return; }
        toast(`${phone} unblocked`);
        renderBlocked(r.data.blocked);
      } catch (e) {
        toast("Could not reach the server. Press again.", true);
      } finally {
        btn.textContent = label;
        delete btn.dataset.armed;
        btn.classList.remove("armed");
        delete btn.dataset.originalLabel;
        ARMED_UNTIL = 0;
      }
    });
  });
}

async function loadBlocked() {
  const { ok, data } = await ajax("/api/admin/blocked");
  if (!ok) { renderBlocked([]); return; }
  renderBlocked(data.blocked);
}

async function blockSubmit() {
  const phone = $("#blockPhone").value.trim();
  const reason = $("#blockReason").value.trim() || "Blocked by owner";
  if (!/^0[245][0-9]{8}$/.test(phone)) { toast("Enter a valid Ghana number, e.g. 0550000000", true); return; }
  const r = await ajax("/api/admin/blocked", { method: "POST", body: JSON.stringify({ phone, reason }) });
  if (!r.ok) { toast(r.data.error || "Could not block", true); return; }
  toast(r.data.already ? `${phone} is already blocked` : `${phone} blocked`);
  $("#blockPhone").value = ""; $("#blockReason").value = "";
  renderBlocked(r.data.blocked);
}

async function loadTopups() {
  const { ok, data } = await ajax("/api/admin/topups");
  if (!ok) { toast(data.error || "Failed to load", true); return; }
  const s = data.settings || { min: 50, max: 10000, chips: [50, 100, 200, 500] };
  /* awaiting_payment is a card top-up the customer started but has not finished.
     It used to fall through the status map and render as the raw string, so the
     owner could not tell it from a real request, and the only buttons offered
     were Approve/Reject, which do not apply to it. */
  const spot = (st) => {
    const m = { pending: "Pending approval", awaiting_payment: "Waiting for card payment", paid: "Approved", rejected: "Rejected", failed: "Failed", cancelled: "Expired / cancelled" };
    return `<span class="badge ${esc(st)}">${esc(m[st] || st)}</span>`;
  };
  $("#topupsView").innerHTML = `
    <div class="feature" style="max-width:700px">
      <h3>Top-up settings</h3>
      <p class="dim">Control what customers can top up, any time you want, without a restart. The limits apply to <b>both</b> Request top-up and Pay now. Requests already waiting are not affected.</p>
      <div class="pin-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:14px 0">
        <div class="field" style="margin:0"><label for="tuMin">Minimum top-up (GHS)</label><input id="tuMin" type="number" inputmode="decimal" min="1" step="0.01" value="${esc(s.min)}" /></div>
        <div class="field" style="margin:0"><label for="tuMax">Maximum top-up (GHS)</label><input id="tuMax" type="number" inputmode="decimal" min="1" step="0.01" value="${esc(s.max)}" /></div>
        <div class="field" style="margin:0"><label for="tuChips">Quick amounts (comma separated)</label><input id="tuChips" maxlength="80" value="${esc(s.chips.join(", "))}" placeholder="50, 100, 200, 500" /></div>
      </div>
      <div class="pay-actions"><button type="button" class="btn btn-primary" id="tuSave">Save top-up settings</button></div>
      <p class="dim" id="tuOut" style="margin-top:12px">${s.updatedAt ? `Last change: ${esc(new Date(s.updatedAt).toLocaleString("en-GB"))}` : "Using the default limits."} Customers currently see: GHS ${esc(s.min)} to GHS ${esc(Number(s.max).toLocaleString())}.</p>
    </div>
    <div class="feature" style="max-width:100%">
      <h3>Top-up requests</h3>
      ${data.topups.length ? `<div style="overflow-x:auto"><table class="admin-table">
        <thead><tr><th>Ref</th><th>Customer</th><th>Phone</th><th>Amount</th><th>Status</th><th>Requested</th><th></th></tr></thead>
        <tbody>${data.topups.map((t) => `<tr>
          <td><b>${esc(t.id)}</b></td>
          <td>${esc(t.name)}</td>
          <td>${esc(t.phone)}</td>
          <td>GHS ${esc(Number(t.amount).toFixed(2))}</td>
          <td>${spot(t.status)}</td>
          <td>${esc(new Date(t.created).toLocaleString())}</td>
          <td>${t.status === "pending"
            ? `<button class="buy-btn" data-id="${esc(t.id)}" data-act="approve">Approve</button>
               <button class="buy-btn danger" data-id="${esc(t.id)}" data-act="reject">Reject</button>`
            : t.status === "awaiting_payment"
            ? `<span class="dim">Card not finished</span>
               <button class="buy-btn danger" data-id="${esc(t.id)}" data-act="reject">Clear</button>`
            : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : '<p class="dim">No top-up requests yet.</p>'}
    </div>`;

  $("#tuSave").addEventListener("click", async () => {
    const btn = $("#tuSave"); btn.disabled = true; btn.textContent = "Saving…";
    const r = await ajax("/api/admin/topup", {
      method: "PUT",
      body: JSON.stringify({ min: $("#tuMin").value, max: $("#tuMax").value, chips: $("#tuChips").value }),
    });
    btn.disabled = false; btn.textContent = "Save top-up settings";
    if (!r.ok) { $("#tuOut").textContent = r.data.error || "Failed to save"; toast(r.data.error || "Failed to save", true); return; }
    toast("Top-up settings saved");
    await loadTopups();
  });

  document.querySelectorAll("#topupsView button[data-id]").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      const { ok, data: r } = await ajax(`/api/admin/topups/${b.dataset.id}`, {
        method: "POST",
        body: JSON.stringify({ action: b.dataset.act }),
      });
      if (!ok) toast(r.error || "Failed", true);
      await loadTopups();
    });
  });
  toast("");
}

async function loadLogs() {
  const { ok, data } = await ajax("/api/admin/logs?limit=200");
  if (!ok) { toast(data.error || "Failed to load", true); return; }
  const color = (t) => (t === "order" ? "#1d4ed8" : t === "topup" ? "#15803d" : t === "auth" ? "#6d28d9" : "#475569");
  $("#logsView").innerHTML = data.logs.length
    ? `<div style="overflow-x:auto"><table class="admin-table">
        <thead><tr><th>Time</th><th>Type</th><th>Activity</th></tr></thead>
        <tbody>${data.logs.map((l) => `<tr>
          <td>${esc(new Date(l.t).toLocaleString())}</td>
          <td><span class="badge" style="background:#f1f5f9;color:${color(l.type)}">${esc(l.type)}</span></td>
          <td style="max-width:560px">${esc(l.msg)}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : '<p class="dim">No activity recorded yet.</p>';
  toast("");
}

async function loadMessaging() {
  const { ok, data } = await ajax("/api/admin/messaging");
  const view = $("#messagingView");
  if (!ok) { view.innerHTML = `<div class="feature"><h3>Could not load</h3><p class="dim">${esc(data.error || "unknown error")}</p></div>`; toast(data.error || "Failed to load", true); return; }
  const w = data.whatsapp || {};
  const badge = (on, label) => `<span class="badge ${on ? "delivered" : "pending"}">${on ? "OK" : "not set"}</span> ${label}`;
  view.innerHTML = `
    <div class="feature" style="max-width:700px">
      <h3>OTP delivery</h3>
      <p class="dim">Customers receive codes over WhatsApp first, then SMS. Current channel: <b>${esc(data.label || data.channel)}</b></p>
      <table class="admin-table" style="margin:14px 0">
        <tbody>
          <tr><td>WhatsApp token + phone ID</td><td>${badge(w.on, "")}</td></tr>
          <tr><td>WhatsApp template</td><td>${badge(w.template, w.template ? esc(w.template) : "free-form text (test number only)")}</td></tr>
          <tr><td>WhatsApp app secret (webhook)</td><td>${badge(w.appSecret, "")}</td></tr>
          <tr><td>WhatsApp verify token</td><td>${badge(w.verifyToken, "")}</td></tr>
          <tr><td>Graph API version</td><td>${esc(w.apiVersion || "n/a")}</td></tr>
          <tr><td>SMS fallback (Arkesel)</td><td>${badge(data.sms.arksel, "")}</td></tr>
          <tr><td>SMS fallback (Africa's Talking)</td><td>${badge(data.sms.africastalking, "")}</td></tr>
        </tbody>
      </table>
      <div class="field"><label for="testPhone">Test number (Ghana, e.g. 0244123456)</label><input id="testPhone" type="tel" inputmode="tel" maxlength="13" placeholder="0500000000" /></div>
      <div class="pay-actions"><button type="button" class="btn btn-primary" id="btnTestOtp">Send test code</button></div>
      <p class="dim" id="testOut" style="margin-top:12px"></p>
      <p class="dim" style="margin-top:18px">Register this webhook in Meta (WhatsApp → Configuration → Webhooks), subscribe to <b>messages</b>:<br><code>${esc(data.webhookUrl)}</code></p>
    </div>`;
  $("#btnTestOtp").addEventListener("click", async () => {
    const btn = $("#btnTestOtp");
    const out = $("#testOut");
    btn.disabled = true; btn.textContent = "Sending…"; out.textContent = "";
    const r = await ajax("/api/admin/test-otp", { method: "POST", body: JSON.stringify({ phone: $("#testPhone").value.trim() }) });
    btn.disabled = false; btn.textContent = "Send test code";
    if (!r.ok) { out.textContent = `Failed: ${r.data.error || "unknown error"}`; out.style.color = "#b91c1c"; return; }
    out.textContent = r.data.mockCode ? `Test mode. Code is ${r.data.mockCode} (not actually sent).` : `Sent via ${r.data.channel} to ${r.data.to}.`;
    out.style.color = "#15803d";
  });
  toast("");
}

init();