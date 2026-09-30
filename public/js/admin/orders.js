/* the order queue: load, triage, render, poll.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
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
