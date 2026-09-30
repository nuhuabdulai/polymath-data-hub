/* Login, the header controls (emergency switch, password panel), the alert bar
   and the dashboard start-up. Tab navigation itself lives in admin.js, the
   orchestrator, next to the registry the tabs are built from.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
function show(view) {
  $("#loginView").hidden = view !== "login";
  $("#dashView").hidden = view !== "dash";
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
