/* sales; activity log.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
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
