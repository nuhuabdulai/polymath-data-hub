/* wallet top-up requests and settings.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
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
