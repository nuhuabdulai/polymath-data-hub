/* per-bundle prices, markup, promo.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */

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
