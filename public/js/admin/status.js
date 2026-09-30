/* network status, supplier keys, automatic approval.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */

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
