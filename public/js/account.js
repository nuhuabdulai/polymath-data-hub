const $ = (s, r = document) => r.querySelector(s);
function esc(s){return String(s??"").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(n) { return Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function toast(msg, isErr) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "toast show" + (isErr ? " err" : ""); clearTimeout(t._t); t._t = setTimeout(() => (t.className = "toast"), 3500);
}
async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || res.statusText || "Request failed"); return data;
}
function statusBadge(s) {
  const map = { pending: "Pending payment", pending_payment: "Awaiting payment", paid: "Paid, processing", processing: "Processing", delivered: "Delivered", failed: "Failed", refunded: "Refunded", tp_pending: "Pending approval", tp_paid: "Approved", tp_rejected: "Rejected" };
  return `<span class="badge ${esc(s)}">${esc(map[s] || s)}</span>`;
}
const NOTICE_ICON = { info: "ℹ️", warning: "⚠️", critical: "🚨" };
/* Top-up limits are set by the owner in the admin (Top-ups tab) and come from
   /api/config, so this page always matches whatever is currently in force. */
let TOPUP = { min: 50, max: 10000, chips: [50, 100, 200, 500] };
const topupRangeText = () => `Enter an amount between GHS ${TOPUP.min.toLocaleString()} and GHS ${TOPUP.max.toLocaleString()}.`;
function renderNoticeBoard(n) {
  const el = $("#noticeBoard");
  if (!el) return;
  if (!n || !n.active || (!n.title && !n.message)) { el.hidden = true; return; }
  const level = ["info", "warning", "critical"].includes(n.level) ? n.level : "info";
  el.className = `notice-board notice-${level}`;
  el.setAttribute("role", level === "info" ? "status" : "alert");
  el.innerHTML = `<div class="wrap notice-inner">
      <span class="notice-icon" aria-hidden="true">${NOTICE_ICON[level]}</span>
      <div class="notice-body">
        ${n.title ? `<b class="notice-title">${esc(n.title)}</b>` : ""}
        ${n.message ? `<p class="notice-msg">${esc(n.message)}</p>` : ""}
      </div>
    </div>`;
  el.hidden = false;
}

const ACCT_NAV = `<div class="pay-actions" style="gap:10px"><a class="btn btn-primary" href="/">← Back to the shop</a></div>`;
const GOOGLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>`;
function safeNext(v) {
  if (!v) return null;
  if (!v.startsWith("/")) return null;
  if (v.startsWith("//")) return null;
  if (v.includes("://")) return null;
  if (v.includes("\\")) return null;
  return v;
}
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg>`;
const WA_SVG_SM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>`;

function renderAuth(opts) {
  /* Signed out: put the header back to its plain wording, and drop the signed-in
     highlight, so the label can never claim you are signed in when you are not. */
  const brand = document.getElementById("acctBrandState");
  if (brand) { brand.textContent = "My Account"; brand.classList.remove("is-on"); }
  const justSignedOut = Boolean(opts && opts.signedOut);
  const nxt = safeNext(new URLSearchParams(location.search).get("next")) || "/account";
  /* Two ways in. Google is the quickest, but it is one external company: if it is
     down, blocked in a customer's browser, or simply refuses, nobody can buy at
     member prices. The email and password form is entirely ours, so the shop can
     always be used. Guest stays available because buying without an account is a
     legitimate choice, not a failure. */
  $("#accMain").innerHTML = `
    <div class="auth-split">
    <div class="app-shell">
      <div class="app-banner"><b>POLYMATH DATA HUB</b></div>
      <div class="app-body">
        <h1 class="app-title">${justSignedOut ? "You have signed out" : "Welcome back"}</h1>
        <p class="app-sub">Sign in for your <b>wallet</b>, <b>order history</b> and cheaper <b>Member Prices</b>.</p>
        <div class="auth-tabs" role="tablist">
          <button type="button" class="auth-tab is-active" id="tabGoogle" role="tab" aria-selected="true">Google</button>
          <button type="button" class="auth-tab" id="tabEmail" role="tab" aria-selected="false">Email or phone</button>
        </div>

        <div class="auth-panel" id="panelGoogle">
          <div class="signin-cta"><a id="gBtn" class="app-btn app-btn-google" href="/api/auth/google?next=${encodeURIComponent(nxt)}"><span style="display:inline-flex;align-items:center;gap:9px">${GOOGLE_SVG} Continue with Google</span></a></div>
          <p class="auth-err" id="gErr" role="alert"></p>
        </div>

        <div class="auth-panel" id="panelEmail" hidden>
          <p class="auth-switch">
            <span id="pwModeLabel">Already have an account?</span>
            <button type="button" class="linky" id="pwSwitch">Create an account</button>
          </p>
          <div id="pwRegisterOnly" hidden>
            <div class="field"><label for="pwName">Your name</label><input id="pwName" autocomplete="name" maxlength="60" placeholder="e.g. Ebenezer Clottey" /></div>
          </div>
          <div class="field"><label for="pwEmail">Email or phone number</label><input id="pwEmail" autocomplete="username" inputmode="email" placeholder="you@gmail.com or 0241234567" /></div>
          <div class="field"><label for="pwPass">Password</label><input id="pwPass" type="password" autocomplete="current-password" placeholder="At least 8 characters" /></div>
          <p class="auth-err" id="pwErr" role="alert"></p>
          <div class="pay-actions"><button type="button" class="app-btn app-btn-primary" id="pwGo">Sign in</button></div>
          <p class="dim" style="margin:14px 0 0;font-size:13.5px">Forgotten your password? Message us on WhatsApp and we will help you back in.</p>
        </div>

        <div class="app-or"><span>or</span></div>
        <a class="app-btn app-btn-ghost" href="/">Browse the shop as a guest</a>
        <div class="app-trust">${LOCK_SVG}<p>Your password is never seen or stored by us in plain text.</p></div>
      </div>
    </div>
    <div class="auth-split-side">
    <div class="acc-card" data-icon="unlock">
      <h2>What signing in gives you</h2>
      <p class="dim">These four things are on your account page the moment you sign in.</p>
      <ul class="benefit-list">
        <li><b>Member prices</b><span>Cheaper than the guest price on every bundle, automatically.</span></li>
        <li><b>A wallet with saved credit</b><span>Top up by card or MoMo and buy in one tap, without typing your number again.</span></li>
        <li><b>Every order in one place</b><span>Your full purchase history with live delivery status and a tracking code per order.</span></li>
        <li><b>Referral credit</b><span>Share your link and you both get GHS 2 after your friend's first purchase.</span></li>
      </ul>
    </div>
    <div class="acc-card acc-guest-buy" data-icon="buy">
      <h2>Not ready to sign in?</h2>
      <p class="dim">Just browsing? You can still buy any bundle right now without an
      account. You pay the guest price, your data is still delivered automatically,
      and you can track the order with the code you are given.</p>
      <div class="pay-actions">
        <a class="btn btn-primary btn-block" href="/">Continue as a guest</a>
        <a class="btn btn-whatsapp btn-block" id="waGuest" href="#" target="_blank" rel="noopener" hidden>\u{1F4AC} Chat with us on WhatsApp</a>
      </div>
    </div>
    </div>
    </div>`;

  let mode = "login";
  const err = $("#pwErr");
  const setMode = (next) => {
    mode = next;
    const reg = next === "register";
    $("#pwRegisterOnly").hidden = !reg;
    $("#pwSwitch").textContent = reg ? "I already have an account" : "Create an account";
    $("#pwModeLabel").textContent = reg ? "New here?" : "Already have an account?";
    $("#pwGo").textContent = reg ? "Create my account" : "Sign in";
    $("#pwPass").setAttribute("autocomplete", reg ? "new-password" : "current-password");
    $("#pwPass").placeholder = reg ? "Choose a password, 8 or more characters" : "Your password";
    err.textContent = "";
  };
  $("#pwSwitch").addEventListener("click", () => setMode(mode === "login" ? "register" : "login"));

  const showTab = (which) => {
    const google = which === "google";
    $("#tabGoogle").classList.toggle("is-active", google);
    $("#tabEmail").classList.toggle("is-active", !google);
    $("#tabGoogle").setAttribute("aria-selected", String(google));
    $("#tabEmail").setAttribute("aria-selected", String(!google));
    $("#panelGoogle").hidden = !google;
    $("#panelEmail").hidden = google;
  };
  $("#tabGoogle").addEventListener("click", () => showTab("google"));
  $("#tabEmail").addEventListener("click", () => showTab("email"));

  $("#pwGo").addEventListener("click", async () => {
    const btn = $("#pwGo");
    const email = $("#pwEmail").value.trim();
    const pass = $("#pwPass").value;
    const name = $("#pwName") ? $("#pwName").value.trim() : "";
    err.textContent = "";
    if (mode === "register" && !name) { err.textContent = "Enter your name."; return; }
    if (!email) { err.textContent = "Enter your email or phone number."; return; }
    if (!pass) { err.textContent = "Enter your password."; return; }
    btn.disabled = true; btn.textContent = mode === "register" ? "Creating your account\u2026" : "Signing in\u2026";
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const body = mode === "register" ? { name, email, password: pass } : { email, password: pass };
      const r = await api(path, { method: "POST", body: JSON.stringify(body) });
      toast(mode === "register" ? "Account created. Welcome!" : "Signed in.");
      if (nxt && nxt !== "/account") { location.href = nxt; return; }
      await renderDash(r.user);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = mode === "register" ? "Create my account" : "Sign in";
    }
  });

  fetch("/api/config").then(r => r.json()).then(cfg => {
    const b = $("#gBtn");
    if (!cfg.googleOn && b) {
      b.remove();
      $("#gErr").textContent = "Google sign-in is unavailable right now, so please use the email or phone tab below.";
      showTab("email");
    }
  }).catch(() => {});
}

/* A friendly goodbye screen rather than a bare reload back to the sign-in form. */
function renderSignedOut() {
  const nxt = safeNext(new URLSearchParams(location.search).get("next")) || "/account";
  $("#accMain").innerHTML = `
    <div class="app-shell">
      <div class="app-banner"><b>POLYMATH DATA HUB</b></div>
      <div class="bye-wrap">
        <div class="bye-icon">
          <span aria-hidden="true">\u{1F44B}</span>
          <span class="bye-check" aria-hidden="true"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg></span>
        </div>
        <h1 class="bye-title">You have signed out</h1>
        <p class="bye-text">Your account is safe and your wallet is locked. Sign in any time to pick up where you left off.</p>
        <div class="bye-actions">
          <a class="app-btn app-btn-primary" href="/">Return to the shop</a>
          <a class="app-btn app-btn-ghost" href="/account">Sign in again</a>
        </div>
      </div>
      <div class="bye-foot"><a id="waBye" href="#" target="_blank" rel="noopener" hidden>${WA_SVG_SM} Need help? Chat with us on WhatsApp</a></div>
    </div>`;
  fetch("/api/config").then(r => r.json()).then((cfg) => {
    const wa = String(((cfg || {}).contact || {}).whatsapp || "").replace(/\D/g, "");
    const link = $("#waBye");
    if (link && wa.length >= 10) { link.href = `https://wa.me/${wa}`; link.hidden = false; }
  }).catch(() => {});
}

async function renderDash(u) {
  /* Confirm the sign-in in the header, under the shop name, so a member can tell at
     a glance which account is open without reading the dashboard. First name only:
     the header is tight on a phone and a long name would push the nav off screen. */
  const brand = document.getElementById("acctBrandState");
  if (brand) {
    const who = String((u && u.name) || "").trim().split(/\s+/)[0];
    brand.textContent = who ? `Signed in · ${who}` : "Signed in";
    brand.classList.add("is-on");
  }
  const [topups, orders, saved, ref, cfg] = await Promise.all([
    api("/api/wallet/topups").catch(() => []),
    api("/api/account/orders").catch(() => []),
    api("/api/account/saved-numbers").catch(()=>[]),
    api("/api/account/referral").catch(()=>null),
    api("/api/config").catch(()=>null),
  ]);
  if (cfg && cfg.topup && Number.isFinite(Number(cfg.topup.min))) {
    TOPUP = {
      min: Number(cfg.topup.min),
      max: Number(cfg.topup.max) || 10000,
      chips: (Array.isArray(cfg.topup.chips) && cfg.topup.chips.length ? cfg.topup.chips : [Number(cfg.topup.min)]).map(Number),
    };
  }
  $("#accMain").innerHTML = `
    <div class="acc-hero"><div><h1>Hi, ${esc(u.name)} 👋</h1><p>${esc(u.phone) ? esc(u.phone) + " · " : ""}${u.email ? esc(u.email) + " · " : ""}member since ${esc(new Date(u.created).toLocaleDateString())}</p></div><div class="wallet-badge"><span>Wallet balance</span><b>GHS ${esc(fmt(u.wallet))}</b></div></div>
    ${ACCT_NAV}
    <div class="acc-dash">
    <div class="acc-card acc-wide" data-icon="add"><h2>Add credit</h2><p class="dim">Pay by card or MoMo and your wallet is credited automatically, or request a top-up and pay by hand.</p>
      <p class="dim" style="margin:0 0 10px">Minimum top-up is <b>GHS ${esc(TOPUP.min.toLocaleString())}</b>, maximum GHS ${esc(TOPUP.max.toLocaleString())}.</p>
      <div class="acc-row"><label class="sr-only" for="tpAmt">Top-up amount in GHS</label><input id="tpAmt" type="text" inputmode="decimal" placeholder="Amount e.g. ${esc(TOPUP.min.toLocaleString())}" /><button type="button" class="btn btn-primary" id="tpPay">Pay now</button><button type="button" class="btn btn-ghost" id="tpGo">Request top-up</button></div>
      <div class="tp-quick">${TOPUP.chips.map((v) => `<button type="button" class="btn btn-ghost" data-amt="${esc(v)}">GHS ${esc(v.toLocaleString())}</button>`).join("")}</div>
      <p class="acc-err" id="tpErr"></p><div id="tpNote"></div>
      ${topups.length ? `<div class="acc-scroll"><table class="admin-table"><thead><tr><th>Ref</th><th>Amount</th><th>Status</th><th>Requested</th></tr></thead><tbody>${topups.map((t) => `<tr><td>${esc(t.id)}</td><td>GHS ${esc(fmt(t.amount))}</td><td>${statusBadge("tp_" + t.status)}</td><td>${esc(new Date(t.created).toLocaleString())}</td></tr>`).join("")}</tbody></table></div>` : '<p class="dim">No top-up requests yet.</p>'}
    </div>
    <div class="acc-card acc-wide" data-icon="nums"><h2>Saved numbers</h2><p class="dim">Save beneficiaries with labels (Me, Mum, Office) for one-tap checkout.</p>
      <div class="acc-row"><label class="sr-only" for="svLabel">Label for this number</label><input id="svLabel" placeholder="Label e.g. Mum" maxlength="20" class="sv-label" /><label class="sr-only" for="svPhone">Beneficiary number</label><input id="svPhone" type="tel" inputmode="numeric" placeholder="024XXXXXXX" maxlength="13" /><button type="button" class="btn btn-primary" id="svAdd">Save</button></div>
      <p class="acc-err" id="svErr"></p>
      ${saved.length ? `<div class="pill-list">${saved.map(s=>`<span class="pill">${esc(s.label)}: ${esc(s.phone)}<button type="button" class="pill-x" data-del="${esc(s.phone)}" data-label="${esc(s.label)}" aria-label="Remove ${esc(s.label)}">✕</button></span>`).join("")}</div>` : '<p class="dim">No saved numbers yet.</p>'}
    </div>
    <div class="acc-card acc-wide" data-icon="bulk"><h2>Bulk orders</h2><p class="dim">Selling to many customers? Pick one bundle and paste up to 50 numbers, one per line. Each one is ordered and delivered separately.</p>
      <div class="field"><label for="boPlan">Bundle</label><select id="boPlan"><option value="">Loading bundles…</option></select></div>
      <div class="field"><label for="boNumbers">Numbers (one per line, or separated by spaces/commas)</label><textarea id="boNumbers" rows="5" placeholder="0244123456&#10;0551234567&#10;0207654321" spellcheck="false"></textarea></div>
      <p class="dim" id="boPreview">Paste your numbers to see the total.</p>
      <label class="agree-row" for="boAgree">
        <input type="checkbox" id="boAgree" />
        <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/refund-policy" target="_blank" rel="noopener">Refund Policy</a> for every number in this order. I understand each number must be eligible for data, must match the bundle network, and must appear only once in this list.</span>
      </label>
      <div class="pay-actions"><button type="button" class="btn btn-pay btn-block" id="boGo" disabled>Send bulk order</button></div>
      <div id="boResult"></div>
    </div>
    <div class="acc-card acc-wide" data-icon="buy"><h2>My purchases</h2>
      ${orders.length ? `<div class="acc-scroll"><table class="admin-table"><thead><tr><th>Order</th><th>Bundle</th><th>Network</th><th>Amount</th><th>Status</th><th>Placed</th><th></th></tr></thead><tbody>${orders.map((o) => `<tr><td><b>${esc(o.id)}</b>${o.trackCode ? `<br><small class="dim">Code: ${esc(o.trackCode)}</small>` : ""}</td><td>${esc(o.planName)}</td><td>${esc(o.network)}</td><td>${esc(o.currency)} ${esc(fmt(o.sell))}</td><td>${statusBadge(o.status)}${o.progress && o.progress.label ? `<br><small class="dim">${esc(o.progress.label)}</small>` : ""}</td><td>${esc(new Date(o.created).toLocaleString())}</td><td><a class="btn btn-ghost" style="padding:6px 12px" href="/?plan=${esc(o.planId)}">Buy again</a></td></tr>`).join("")}</tbody></table></div>` : '<p class="dim">You haven\'t bought anything yet, <a href="/">pick a bundle</a>.</p>'}
    </div>
    <div class="acc-card" data-icon="ref"><h2>Referrals</h2><p class="dim">Share your link. When a friend makes their first purchase, you both get GHS 2.</p>
      ${ref ? `<div class="field"><input id="refLink" value="${esc(ref.link)}" readonly style="font-size:13px" /></div><div class="pay-actions"><button type="button" class="btn btn-whatsapp btn-block" id="refWa">Share on WhatsApp ↗</button><button type="button" class="btn btn-ghost btn-block" id="refCopy">Copy link</button></div>` : '<p class="dim">Sign in to get your link.</p>'}
    </div>
    <div class="acc-card" data-icon="set"><h2>Account &amp; session</h2><div class="acc-row"><button type="button" class="btn btn-ghost" id="signOut">Sign out</button></div>
      <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px"><h3 style="font-size:14px">Your contact number</h3><p class="dim">${u.phone ? "Used on your orders and top-ups so we can reach you." : "Add it so we can reach you about top-ups and orders."}</p><div class="acc-row"><input id="myPhone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="13" placeholder="024XXXXXXX" value="${esc(u.phone || "")}" /><button type="button" class="btn btn-primary" id="myPhoneGo">Save</button></div><p class="auth-err" id="myPhoneErr"></p></div>
    </div>
    </div>`;
  $("#tpGo").addEventListener("click", async () => {
    const amount = Number($("#tpAmt").value); const note = $("#tpNote");
    if (!Number.isFinite(amount) || amount < TOPUP.min || amount > TOPUP.max) { const e = $("#tpErr"); e.textContent = topupRangeText(); toast(topupRangeText(), true); return; }
    $("#tpErr").textContent = "";
    const btn = $("#tpGo"); btn.disabled = true; btn.textContent = "Requesting…";
    try { const r = await api("/api/wallet/topup", { method: "POST", body: JSON.stringify({ amount }) }); note.innerHTML = `<p class="notice" style="margin-top:10px">Top-up <b>${esc(r.id)}</b> for <b>GHS ${esc(fmt(r.amount))}</b>. ${esc(r.note)}</p>`; toast("Top-up requested, pay then we approve it."); } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = "Request top-up"; renderDash(u);
  });
  // quick amount chips
  document.querySelectorAll("[data-amt]").forEach((b) => b.addEventListener("click", () => {
    const inp = $("#tpAmt"); inp.value = b.dataset.amt; inp.focus();
  }));
  // Pay now -> Paystack checkout, wallet credited by the verified webhook
  const payBtn = $("#tpPay");
  if (payBtn) payBtn.addEventListener("click", async () => {
    const amount = Number($("#tpAmt").value);
    const err = $("#tpErr");
    if (!Number.isFinite(amount) || amount < TOPUP.min || amount > TOPUP.max) { err.textContent = topupRangeText(); toast(topupRangeText(), true); return; }
    err.textContent = "";
    payBtn.disabled = true; payBtn.textContent = "Opening checkout…";
    try {
      const r = await api("/api/wallet/topup/paystack", { method: "POST", body: JSON.stringify({ amount }) });
      if (r.url) { location.href = r.url; return; }
      err.textContent = "Payment could not start. Use the request option instead.";
      payBtn.disabled = false; payBtn.textContent = "Pay now";
    } catch (e) {
      err.textContent = e.message;
      toast(e.message, true);
      payBtn.disabled = false; payBtn.textContent = "Pay now";
      if (/unavailable|not available/i.test(e.message || "")) {
        err.innerHTML += ' <a href="#" id="tpFallback">Use Request top-up instead</a>';
        const f = $("#tpFallback");
        if (f) f.addEventListener("click", (ev) => { ev.preventDefault(); $("#tpGo").focus(); });
      }
    }
  });
  $("#signOut").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    // A goodbye screen, not a silent jump back to the sign-in form.
    history.replaceState(null, "", "/account");
    renderSignedOut();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // saved numbers
  const svAdd = $("#svAdd"); if(svAdd) svAdd.addEventListener("click", async()=>{
    const label=$("#svLabel").value.trim(); const phone=$("#svPhone").value.replace(/\D/g,"");
    const err=$("#svErr"); err.textContent="";
    const btn=svAdd; btn.disabled=true; btn.textContent="Saving…";
    try{ await api("/api/account/saved-numbers",{method:"POST",body:JSON.stringify({label,phone})}); toast("Saved"); renderDash(u);}catch(e){ err.textContent=e.message; toast(e.message,true); btn.disabled=false; btn.textContent="Save"; }
  });
  document.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click", async()=>{
    const who = b.dataset.label || b.dataset.del;
    if (!window.confirm(`Remove "${who}" (${b.dataset.del}) from your saved numbers?`)) return;
    b.disabled=true;
    try{ await api(`/api/account/saved-numbers/${b.dataset.del}`,{method:"DELETE"}); toast("Removed"); renderDash(u);}catch(e){ toast(e.message,true); b.disabled=false; }
  }));
  // referrals
  const refWa=$("#refWa"); if(refWa) refWa.addEventListener("click",()=>{
    const link=$("#refLink").value; const msg=`Get cheap data bundles at ${location.origin}. Use my link ${link} and we both get GHS 2!`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`,"_blank");
  });
  const refCopy=$("#refCopy"); if(refCopy) refCopy.addEventListener("click",async()=>{
    const link=$("#refLink").value; try{ await navigator.clipboard.writeText(link); toast("Link copied"); }catch{ toast(link); }
  });
  // bulk orders
  const boPlan = $("#boPlan");
  if (boPlan) {
    api("/api/products").then((r) => {
      const ps = (r.products || []).slice().sort((a, b) => (a.network || "").localeCompare(b.network || "") || (a.sizeMb || 0) - (b.sizeMb || 0));
      boPlan.innerHTML = '<option value="">Choose a bundle…</option>' + ps.map((p) => `<option value="${esc(p.id)}" data-price="${esc(p.memberPrice || p.sell || 0)}">${esc(p.network)} ${esc(p.name || "")}, GHS ${esc(fmt(p.memberPrice || p.sell || 0))}</option>`).join("");
    }).catch(() => { boPlan.innerHTML = '<option value="">Could not load bundles</option>'; });

    const boNumbers = $("#boNumbers");
    const boPreview = $("#boPreview");
    const boGo = $("#boGo");
    const unitPrice = () => Number(boPlan.selectedOptions[0] && boPlan.selectedOptions[0].dataset.price || 0);
    const parsedNumbers = () => boNumbers.value.split(/[\s,;]+/).map((s) => s.replace(/\D/g, "").replace(/^233/, "0")).filter(Boolean);

    const refresh = () => {
      const nums = parsedNumbers();
      const bad = nums.filter((n) => !/^0[245][0-9]{8}$/.test(n));
      const price = unitPrice();
      const ok = nums.length > 0 && !bad.length && boPlan.value && nums.length <= 50;
      boGo.disabled = !ok;
      if (!nums.length) { boPreview.textContent = "Paste your numbers to see the total."; return; }
      if (bad.length) { boPreview.innerHTML = `<span style="color:#b91c1c">${bad.length} number${bad.length > 1 ? "s are" : " is"} not a valid Ghana mobile number. Fix them first.</span>`; return; }
      if (nums.length > 50) { boPreview.innerHTML = `<span style="color:#b91c1c">Too many numbers: ${nums.length}. The limit is 50 per order.</span>`; return; }
      if (!boPlan.value) { boPreview.textContent = `${nums.length} number${nums.length > 1 ? "s" : ""} ready. Choose a bundle.`; return; }
      const total = price * nums.length;
      const short = u.wallet < total;
      boPreview.innerHTML = `${nums.length} × GHS ${fmt(price)} = <b>GHS ${fmt(total)}</b>` + (short ? ` <span style="color:#b91c1c">Your balance is GHS ${fmt(u.wallet)}, so top up first.</span>` : "");
    };
    boPlan.addEventListener("change", refresh);
    boNumbers.addEventListener("input", refresh);

    const boAgree = $("#boAgree");
    const syncBoAgree = () => { boGo.disabled = !boAgree.checked; };
    if (boAgree) { boAgree.addEventListener("change", syncBoAgree); syncBoAgree(); }
    boGo.addEventListener("click", async () => {
      const btn = boGo; const out = $("#boResult");
      const nums = parsedNumbers();
      if (boAgree && !boAgree.checked) { out.innerHTML = '<span style="color:#b91c1c">Tick the agreement box first.</span>'; return; }
      btn.disabled = true; btn.textContent = `Ordering ${nums.length}…`; out.innerHTML = "";
      try {
        const r = await api("/api/wallet/bulk-order", { method: "POST", body: JSON.stringify({ rows: nums.map((phone) => ({ phone, planId: boPlan.value })), terms: true }) });
        const okN = r.delivered || 0, failN = r.failed || 0;
        out.innerHTML = `<div class="notice" style="margin-top:12px"><b>Done.</b> ${r.orders.length} order${r.orders.length > 1 ? "s" : ""} placed. Total GHS ${fmt(r.total)}.<br>${okN} delivered now, ${r.orders.length - okN - failN} processing.${failN ? `<br><span style="color:#b91c1c">${failN} failed. Message us on WhatsApp with this time and we will refund those.</span>` : ""}<br>New balance: <b>GHS ${fmt(r.balance)}</b></div><div style="overflow-x:auto;margin-top:12px"><table class="admin-table"><thead><tr><th>Number</th><th>Bundle</th><th>Status</th><th>Ref</th></tr></thead><tbody>${r.orders.map((o) => `<tr><td>${esc(o.phone)}</td><td>${esc(o.planName)}</td><td>${statusBadge(o.status)}</td><td><a class="btn btn-ghost" style="padding:4px 10px" href="/?plan=${esc(o.planId)}">Buy again</a></td></tr>`).join("")}</tbody></table></div>`;
        const badge = $(".wallet-badge b"); if (badge) badge.textContent = `GHS ${fmt(r.balance)}`;
        boNumbers.value = "";
        toast(`${r.orders.length} orders placed.`);
      } catch (e) {
        if (e.rows) {
          out.innerHTML = `<div class="notice" style="margin-top:12px;border-color:#b91c1c"><b>Nothing was charged.</b> Fix these rows and try again:</div><ul style="margin:8px 0 0 18px">${e.rows.filter((x) => x.error).map((x) => `<li>${esc(x.phone || "(blank)")}: ${esc(x.error)}</li>`).join("")}</ul>`;
        } else out.innerHTML = `<p class="auth-err" style="margin-top:12px">${esc(e.message)}</p>`;
      }
      btn.disabled = false; btn.textContent = "Send bulk order";
      refresh();
    });
  }
  // contact number
  $("#myPhoneGo").addEventListener("click", async () => {
    const btn = $("#myPhoneGo"); btn.disabled = true; btn.textContent = "Saving…"; $("#myPhoneErr").textContent = "";
    try { const nu = await api("/api/auth/phone", { method: "PUT", body: JSON.stringify({ phone: $("#myPhone").value }) }); toast("Saved"); await renderDash(nu); }
    catch (e) { $("#myPhoneErr").textContent = e.message; btn.disabled = false; btn.textContent = "Save"; }
  });
}
/* Footer contact + WhatsApp float, same as the storefront (app.js is not loaded here). */
function fillFooter(config) {
  const c = (config && config.contact) || {};
  const tag = $("#footTag"); if (tag) tag.textContent = `${(config && config.siteName) || "POLYMATH DATA HUB"}. Data bundles, delivered automatically.`;
  const mail = $("#footMail");
  if (mail && c.email) { mail.innerHTML = ""; const a = document.createElement("a"); a.href = `mailto:${c.email}`; a.textContent = c.email; mail.appendChild(a); }
  const ph = $("#footPhone");
  if (ph && c.phone) { ph.href = `tel:${String(c.phone).replace(/[^\d+]/g, "")}`; ph.textContent = c.phone; ph.hidden = false; }
  const loc = $("#footLocation"); if (loc && c.location) loc.textContent = c.location;
  const wa = String(c.whatsapp || "").replace(/\D/g, "");
  if (wa && wa.length >= 10) {
    [$("#footWa"), $("#waFloat"), $("#waGuest")].forEach((b) => { if (b) { b.href = `https://wa.me/${wa}`; b.hidden = false; } });
  }
}

(async function boot() {
  $("#year").textContent = new Date().getFullYear();
  fetch("/api/config").then((r) => r.json()).then((c) => { renderNoticeBoard(c.notice); fillFooter(c); }).catch(() => {});
  const track = $("#footTrack");
  if (track) track.addEventListener("click", () => { location.href = "/#track"; });

  /* Redeem a sign-in ticket before deciding who the visitor is. A Cloudflare
     Worker intercepts the Google callback and never delivers its cookie, so the
     callback hands over a single-use ticket instead and the session is created
     here, on a path the Worker ignores. Without this the page would show the
     sign-up form straight after a successful Google sign-in. */
  const params = new URLSearchParams(location.search);
  const ticket = params.get("xchg");
  if (ticket) {
    try {
      const r = await api("/api/auth/exchange", { method: "POST", body: JSON.stringify({ code: ticket }) });
      // Drop the ticket from the address bar so it cannot be reused or shared.
      const clean = location.pathname + (params.get("next") ? "?next=" + encodeURIComponent(params.get("next")) : "");
      history.replaceState(null, "", clean);
      await renderDash(r.user);
      return;
    } catch (e) {
      // A spent or expired ticket just means "not signed in"; fall through.
    }
  }
  try { const u = await api("/api/auth/me"); await renderDash(u); } catch (e) { renderAuth(); }
})();
