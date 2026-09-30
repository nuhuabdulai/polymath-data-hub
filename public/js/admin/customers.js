/* customers and blocked numbers.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */

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
