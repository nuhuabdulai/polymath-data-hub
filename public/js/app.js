const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { config: null, products: [], network: null, me: null, plan: null, step: "number", phone: "", email: "" };

function fmt(n) { return Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
async function api(path, opts) {
  let res;
  try { res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts }); }
  catch (e) { throw new Error("Network problem. Check your connection and try again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}
function toast(msg, isErr, ms = 3200) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = "toast"), ms);
}
function showOrderError(msg) {
  const error = $("#orderErr");
  if (error) error.textContent = String(msg || "We could not place this order.");
  toast(msg, true, 6000);
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function progressHtml(progress) {
  if (!progress || !Array.isArray(progress.steps)) return "";
  return `<div class="progress-track" role="list" aria-label="Order progress">${progress.steps.map((step) => `<div class="progress-step ${esc(step.state)}" role="listitem"><span class="progress-dot" aria-hidden="true">${step.state === "complete" ? "✓" : step.state === "current" ? "•" : ""}</span><span>${esc(step.label)}</span></div>`).join("")}</div><p class="progress-label">${esc(progress.label || "")}</p>`;
}
function networkStyle(name) {
  const n = (state.config && state.config.networks || []).find((x) => x.name === name);
  return n ? { color: n.color, text: n.text } : { color: "#555", text: "#fff" };
}
function humanSize(mb) {
  const v = Number(mb); if (!v) return "";
  return v >= 1024 ? `${(v / 1024).toFixed(v % 1024 ? 1 : 0)}GB` : `${v}MB`;
}
function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 9 && /^[245][0-9]{8}$/.test(d)) d = "0" + d;
  else if (d.startsWith("233") && d.length >= 11) d = "0" + d.slice(3);
  else if (d.startsWith("233")) d = d.replace(/^233/, "0");
  return d;
}
function formatGh(phone) {
  const n = normalizePhone(phone);
  if (n.length === 10) return `${n.slice(0,3)} ${n.slice(3,6)} ${n.slice(6)}`;
  return n;
}
const PREFIX_NET = [
  ["MTN", ["024", "025", "053", "054", "055", "059"]],
  ["Telecel", ["020", "050"]],
  ["AirtelTigo", ["026", "027", "056", "057"]],
];
const PREFIXES = PREFIX_NET; // alias per FIXES.md
function guessNetwork(phone) {
  const n = normalizePhone(phone);
  const pref = (n.startsWith("0") ? n : "0" + n).slice(0, 3);
  if (pref.length < 3) return null;
  const hit = PREFIX_NET.find(([, prefs]) => prefs.includes(pref));
  return hit ? hit[0] : null;
}
/* The nav must say plainly which state the visitor is in, so nobody is left
   wondering whether they are signed in. Signed out says "Sign in"; signed in
   greets by name and shows the wallet. */
function renderAcct() {
  const chip = $("#acctChip"); if (!chip) return;
  const link = $("#acctLink");
  if (state.me) {
    const first = String(state.me.name || "").split(" ")[0];
    chip.hidden = false;
    chip.textContent = ` · GHS ${fmt(state.me.wallet)}`;
    if (link) {
      link.setAttribute("href", "/account");
      link.setAttribute("data-signed-in", "1");
      link.setAttribute("title", `Signed in as ${state.me.name || "member"}`);
      link.firstChild && (link.firstChild.nodeValue = first ? `Hi, ${first}` : "My account");
    }
  } else {
    chip.hidden = true; chip.textContent = "";
    if (link) {
      link.setAttribute("href", "/account");
      link.removeAttribute("data-signed-in");
      link.removeAttribute("title");
      link.firstChild && (link.firstChild.nodeValue = "Sign in");
    }
  }
}
function showSkeleton() {
  const grid = $("#plans"); if (!grid) return;
  grid.innerHTML = `${[0, 1, 2, 3, 4, 5].map(() => `<div class="skel-card" aria-hidden="true"><div class="skel skel-x w60"></div><div class="skel skel-xl w40"></div><div class="skel skel-line w90"></div><div class="skel skel-btn w80"></div></div>`).join("")}`;
  const loading = $("#loading"); if (loading) loading.hidden = true;
}
function errorState(msg) {
  const grid = $("#plans");
  if (grid) grid.innerHTML = `<div class="state-box" role="alert"><h3>We couldn't load the bundles</h3><p>${esc(msg || "Please check your connection and try again.")}</p><button type="button" class="btn btn-primary" id="retryBtn">TRY AGAIN</button></div>`;
  const retry = $("#retryBtn"); if (retry) retry.addEventListener("click", () => { showSkeleton(); load(); });
}
function gridEmpty(msg) {
  const grid = $("#plans");
  if (grid) grid.innerHTML = `<div class="state-box"><h3>No bundles available</h3><p>${esc(msg || "")}</p>${state.config && state.config.contact.whatsapp ? `<a class="btn btn-whatsapp" href="https://wa.me/${esc(state.config.contact.whatsapp)}" target="_blank" rel="noopener">Ask on WhatsApp</a>` : ""}</div>`;
  const loading = $("#loading"); if (loading) loading.hidden = true;
}

async function load() {
  showSkeleton();
  try {
    const [config, data] = await Promise.all([api("/api/config"), api("/api/products")]);
    state.config = config;
    state.products = Array.isArray(data.products) ? data.products : [];
    api("/api/auth/me").then((me) => {
      state.me = me; renderAcct(); render(); updateSaveBanner();
      const pr = (()=>{ try{return localStorage.getItem("pending_ref")}catch{return null}})();
      if (pr) api("/api/account/claim-referral", {method:"POST", body: JSON.stringify({code: pr})}).then((r)=>{ try{localStorage.removeItem("pending_ref")}catch{}; toast(r && r.credited ? "Referral bonus credited. GHS 2 added to your wallet!" : "Referral saved. Your GHS 2 arrives after your first payment."); }).catch(()=>{ try{localStorage.removeItem("pending_ref")}catch{}});
    }).catch(() => { state.me = null; renderAcct(); });

    const yEl = $("#year"); if (yEl) yEl.textContent = new Date().getFullYear();
    const ftEl = $("#footTag"); if (ftEl) ftEl.textContent = `${config.siteName}, data bundles, delivered automatically.`;
    const fmEl = $("#footMail");
    if (fmEl) {
      const em = config.contact.email || "";
      if (em) { fmEl.innerHTML = `<a href="mailto:${esc(em)}">${esc(em)}</a>`; fmEl.hidden = false; }
      else fmEl.hidden = true;
    }
    const fp = $("#footPhone");
    if (fp) {
      const ph = config.contact.phone || "";
      if (ph) {
        const digits = ph.replace(/\D/g,"");
        const tel = digits.startsWith("233") ? `+${digits}` : digits.startsWith("0") ? `+233${digits.slice(1)}` : `+233${digits}`;
        fp.textContent = ph;
        fp.href = `tel:${tel}`;
        fp.hidden = false;
      } else fp.hidden = true;
    }
    if ($("#footLocation")) $("#footLocation").textContent = config.contact.location || "Accra, Ghana";
    // P2: hide deliveredToday when <10, show week
    const dTodayEl = $("#deliveredToday");
    if (dTodayEl) {
      const today = config.deliveredToday || 0;
      const week = config.deliveredWeek || 0;
      if (today >= 10) { dTodayEl.textContent = `${today} orders delivered today`; dTodayEl.hidden = false; }
      else if (week >= 10) { dTodayEl.textContent = `${week} orders delivered this week`; dTodayEl.hidden = false; }
      else dTodayEl.hidden = true;
    }
    // status banner
    renderStatusBanner(config.statusBanner);
    renderNoticeBoard(config.notice);
    updateSaveBanner();

    const wa = config.contact && config.contact.whatsapp;
    if (wa) {
      const waLink = `https://wa.me/${wa}`;
      [$("#waBtn"), $("#footWa"), $("#trustWa"), $("#waFloat"), $("#heroWa")].forEach((b) => { if (b) { b.href = waLink; b.hidden = false; } });
    }
    // share button
    const shareBtn = $("#shareBtn");
    if (shareBtn) shareBtn.addEventListener("click", () => {
      const text = `Cheap data bundles at ${location.origin}. MTN from GHS ${fmt((state.products.find(p=>p.network==="MTN")||{}).memberPrice||4.77)}!`;
      const url = `https://wa.me/?text=${encodeURIComponent(text + " " + location.origin)}`;
      window.open(url, "_blank");
    });

    buildQuickBuy();
    // landing pages: /mtn etc force network
    if (window.FORCE_NETWORK && state.products.some(p=>p.network===window.FORCE_NETWORK)) state.network = window.FORCE_NETWORK;

    function renderHero(pick) {
      const ns = networkStyle(pick.network);
      const heroCard = $("#heroCard");
      if (!heroCard) return;
      const mp = pick.memberPrice || pick.sell;
      heroCard.innerHTML = `<span class="m-net" style="color:${ns.color}">${esc(pick.network)}</span><strong>${esc(humanSize(pick.sizeMb) || "Bundle")}</strong><span class="m-price">${esc(config.currency)} ${esc(fmt(mp))}<span class="m-old">Guest ${esc(config.currency)} ${esc(fmt(pick.guestPrice || pick.sell))}</span></span><span class="m-tag">Member price, save ~${config.savePercent||26}%</span><button type="button" tabindex="-1">Order now</button>`;
      heroCard.addEventListener("click", (e) => { if (e.target.closest("button")) return; openOrder(pick.id); });
    }
    if (state.products.length) {
      renderHero(state.products[0]);
    }

    const forced = (document.body.dataset.network || window.FORCE_NETWORK || "").trim();
    if (forced) window.FORCE_NETWORK = forced;
    if (state.products.length && !window.FORCE_NETWORK) {
      // auto-select network from hero quick-buy or first product
      state.network = state.products[0].network;
      renderPills(); render();
    } else if (state.products.length && window.FORCE_NETWORK) {
      state.network = window.FORCE_NETWORK;
      renderPills(); render();
    } else if (config.networks && config.networks[0]) {
      state.network = config.networks[0].name; renderPills(); gridEmpty("Bundles are being updated. Please check back shortly.");
    } else gridEmpty();
  } catch (e) { errorState(e.message); }
}
function updateSaveBanner() {
  const el = $("#saveBanner");
  if (!el || !state.config) return;
  if (state.me) { el.hidden = true; return; }
  const pct = state.config.savePercent || 26;
  el.hidden = false;
  // The whole sentence is one <span> so the flex row cannot break it apart.
  el.innerHTML = `<span>🔓 <b>Sign in for member prices</b>. Save up to ~${pct}% on every bundle.</span>
    <button type="button" class="link-btn" id="saveBannerGo">Get member price →</button>`;
  const go = $("#saveBannerGo");
  if (go) go.addEventListener("click", () => {
    const first = state.products[0]; if (first) openMemberChoice(first.id);
  });
}
function renderStatusBanner(st) {
  const el = $("#statusBanner"); if (!el || !st) return;
  const labels = { normal: "Normal ✅", delayed: "Delayed ⚠️", down: "Down ❌" };
  const any = ["mtn","telecel","airteltigo"].some(k => st[k] && st[k] !== "normal");
  if (!any && !st.message) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="wrap" style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;font-weight:700"><span>MTN: ${labels[st.mtn]||st.mtn}</span><span>Telecel: ${labels[st.telecel]||st.telecel}</span><span>AirtelTigo: ${labels[st.airteltigo]||st.airteltigo}</span>${st.message?`<span style="font-weight:600"> ${esc(st.message)}</span>`:""}</div>`;
}

/* Buyer notice board: the owner posts these from admin > Status. */
const NOTICE_ICON = { info: "ℹ️", warning: "⚠️", critical: "🚨" };
function renderNoticeBoard(n) {
  let el = $("#noticeBoard");
  if (!n || !n.active || (!n.title && !n.message)) {
    if (el) el.hidden = true;
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "noticeBoard";
    // Put it directly under the header so it is impossible to miss, above the hero
    // and above the per-network status banner.
    const header = document.querySelector("header.site-header");
    const anchor = header || $("#statusBanner");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
    else document.body.insertBefore(el, document.body.firstChild);
  }
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

const DELIVERY_TEXT = {
  normal: "⚡ Usually 2-5 min",
  delayed: "⏳ Slow, may take hours",
  down: "⛔ Not delivering now",
};
function deliveryNote(network) {
  const st = (state.config && state.config.statusBanner) || {};
  const key = String(network || "").toLowerCase();
  const s = st[key] || "normal";
  return { cls: `plan-instant plan-instant-${s}`, text: DELIVERY_TEXT[s] || DELIVERY_TEXT.normal };
}

function buildQuickBuy() {
  const hero = $(".hero-copy");
  if (!hero || $("#quickBuy")) return;
  const wrap = document.createElement("div");
  wrap.id = "quickBuy";
  wrap.className = "quick-buy";
  wrap.innerHTML = `
    <div class="qb-row">
      <input id="qbPhone" type="tel" inputmode="numeric" placeholder="Phone: 0241234567" maxlength="13" aria-label="Phone number" />
      <select id="qbBundle" aria-label="Bundle size"></select>
      <button type="button" class="btn btn-primary" id="qbGo">Buy now</button>
    </div>
    <p class="hint" id="qbHint"></p>`;
  hero.appendChild(wrap);
  const sel = $("#qbBundle");
  if (sel && state.products.length) {
    // group by size for dropdown
    sel.innerHTML = state.products.map(p => `<option value="${esc(p.id)}" data-net="${esc(p.network)}">${esc(p.network)} ${esc(humanSize(p.sizeMb))}, GHS ${esc(fmt(p.memberPrice||p.sell))} (member)</option>`).join("");
  }
  const phoneEl = $("#qbPhone");
  const hint = $("#qbHint");
  const updateNet = () => {
    const g = guessNetwork(phoneEl.value);
    if (g && state.products.some(p=>p.network===g)) {
      state.network = g; renderPills(); render();
      if (sel) {
        // select first bundle of that network
        const first = state.products.find(p=>p.network===g);
        if (first) sel.value = String(first.id);
      }
      hint.textContent = `Detected ${g} number. Showing ${g} bundles. Switched automatically.`;
      hint.className = "hint ok";
    } else if (phoneEl.value.replace(/\D/g, "").length >= 3) {
      hint.textContent = `Enter a 10-digit Ghana number (024, 020, 026 etc).`;
      hint.className = "hint";
    } else hint.textContent = "";
  };
  phoneEl.addEventListener("input", updateNet);
  sel && sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    const net = opt && opt.dataset.net;
    if (net) { state.network = net; renderPills(); render(); }
  });
  $("#qbGo").addEventListener("click", () => {
    const raw = normalizePhone(phoneEl.value);
    if (!/^0[245][0-9]{8}$/.test(raw)) { toast("Enter a valid Ghana number for quick buy.", true); phoneEl.focus(); return; }
    const pid = sel.value;
    if (!pid) return;
    // prefill phone for checkout
    state.phone = raw;
    openOrder(pid);
  });
}

function renderPills() {
  const el = $("#netPills"); if (el && state.config) {
    el.innerHTML = state.config.networks.map((n) => `<span class="pill-net${n.name === state.network ? " active" : ""}" data-net="${esc(n.name)}" style="background:${n.color};color:${n.text}">${esc(n.name)}</span>`).join("");
    $$(".pill-net", el).forEach((p) => p.addEventListener("click", () => setNetwork(p.dataset.net)));
  }
  // also sync quick-buy hint
}
function setNetwork(net) { state.network = net; renderPills(); render(); }
function netOptions(only = []) { const all = state.config ? state.config.networks.map((n) => n.name) : []; return only.length ? all.filter((n) => only.includes(n)) : all; }

function render() {
  const grid = $("#plans"); if (!grid) return;
  const tabs = $("#tabs");
  const nets = netOptions([...new Set(state.products.map((p) => p.network))]);
  const loading = $("#loading"); if (loading) loading.hidden = true;
  if (tabs) {
    tabs.innerHTML = nets.map((n) => `<button type="button" class="tab ${n === state.network ? "active" : ""}" data-tab="${esc(n)}">${esc(n)}</button>`).join("");
    $$(".tab", tabs).forEach((t) => t.addEventListener("click", () => { state.network = t.dataset.tab; renderPills(); render(); }));
  }
  let plans = state.products.filter((p) => p.network === state.network);
  if (!plans.length) { gridEmpty("No bundles for this network right now. Try another."); return; }
  // group by size
  const groups = { small: plans.filter(p=>p.sizeMb>0 && p.sizeMb < 6*1024), medium: plans.filter(p=>p.sizeMb>=6*1024 && p.sizeMb < 25*1024), bulk: plans.filter(p=>p.sizeMb>=25*1024), other: plans.filter(p=>!p.sizeMb) };
  const ordered = [...groups.small, ...groups.medium, ...groups.bulk, ...groups.other];
  if (ordered.length) plans = ordered;
  const conf = state.config;
  grid.innerHTML = plans.map((p) => {
    const ns = networkStyle(p.network);
    const badge = p.bestValue ? `<span class="car-badge best">★ Best value</span>` : "";
    const mp = p.memberPrice || p.sell;
    const gp = p.guestPrice || p.sell;
    const isMember = Boolean(state.me);
    const del = deliveryNote(p.network);
    return `<div class="plan-card" role="button" tabindex="0" data-id="${esc(p.id)}" aria-label="${esc(p.network)} ${esc(humanSize(p.sizeMb))} for ${esc(conf.currency)} ${esc(fmt(mp))}">
      <div class="plan-top"><span class="net-badge" style="background:${ns.color};color:${ns.text}">${esc(p.network)}</span>${badge}</div>
      <div class="plan-size">${esc(humanSize(p.sizeMb) || "n/a")}</div>
      <div class="plan-price"><span class="price-member">${esc(conf.currency)} ${esc(fmt(mp))}</span> <small class="price-label">Member price</small></div>
      <div class="price-guest">Guest ${esc(conf.currency)} ${esc(fmt(gp))}</div>
      <div class="plan-meta"><span class="${del.cls}">${esc(del.text)}</span><span class="plan-valid">${esc(p.validity || "auto-tracked")}</span></div>
      <button type="button" class="buy-btn btn-block">${isMember ? "BUY NOW" : "Get it →"}</button>
    </div>`;
  }).join("");
  $$(".plan-card", grid).forEach((c) => {
    c.addEventListener("click", () => openMemberChoice(c.dataset.id));
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMemberChoice(c.dataset.id); } });
  });
}

function phoneWarnHtml(phone) {
  if (!state.plan) return "";
  const guess = guessNetwork(phone);
  if (!guess) return "";
  if (guess === state.plan.network) return `<p class="net-hint ok">✓ ${esc(guess)} number, matches this bundle.</p>`;
  const art = (guess==="MTN" || /^[AEIOU]/i.test(guess)) ? "an" : "a";
  return `<p class="net-hint warn">⚠️ Looks like ${art} ${esc(guess)} number. You selected ${esc(state.plan.network)}. Check before paying (ported numbers keep their old prefix).</p>`;
}

function openMemberChoice(planId) {
  const plan = state.products.find((p) => String(p.id) === String(planId));
  if (!plan) return toast("Bundle not found", true);
  state.plan = plan;
  showBuyBar(plan);
  if (state.me) { stepNumber(); openModal(); return; }
  // guest: show member vs guest choice modal
  const conf = state.config;
  const mp = plan.memberPrice || plan.sell;
  const gp = plan.guestPrice || plan.sell;
  $("#modalInner").innerHTML = `
    <h3>${esc(humanSize(plan.sizeMb) || plan.name)} · ${esc(plan.network)}</h3>
    <p class="dim">Choose how you want to pay:</p>
    <div class="choice-cards">
      <button type="button" class="choice-card primary" id="choiceMember">
        <span class="choice-title">Get it for ${esc(conf.currency)} ${esc(fmt(mp))}</span>
        <span class="choice-sub">Member price: sign in with Google (10 sec)</span>
        <span class="choice-badge">Save ~${conf.savePercent||26}%</span>
      </button>
      <button type="button" class="choice-card" id="choiceGuest">
        <span class="choice-title">Continue as guest: ${esc(conf.currency)} ${esc(fmt(gp))}</span>
        <span class="choice-sub">No account needed: pay guest price</span>
      </button>
    </div>
    <div class="trust-mini">🔒 Secure checkout · <span id="cmWa"></span></div>`;
  const wa = conf.contact && conf.contact.whatsapp;
  if (wa && $("#cmWa")) $("#cmWa").innerHTML = `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">Support on WhatsApp</a>`;
  openModal();
  $("#choiceMember").addEventListener("click", () => { if (state.me) stepNumber(); else stepGoogle(); });
  $("#choiceGuest").addEventListener("click", () => { stepNumber(); });
}

const GOOGLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>`;

function stepGoogle() {
  const plan = state.plan; if (!plan) return;
  const conf = state.config;
  state.step = "google";
  const next = `/?plan=${encodeURIComponent(plan.id)}#shop`;
  const gUrl = `/api/auth/google?next=${encodeURIComponent(next)}`;
  $("#modalInner").innerHTML = `
    <h3>Sign in to get the member price</h3>
    <p class="dim">One tap with Google. You keep your orders, wallet and saved numbers.</p>
    ${conf.googleOn
      ? `<div style="margin:16px 0"><a class="btn btn-block" href="${esc(gUrl)}" style="border:1px solid #dadce0; background:#fff; color:#1a73e8; font-weight:600"><span style="display:inline-flex;align-items:center;gap:8px">${GOOGLE_SVG} Continue with Google</span></a></div>`
      : `<p class="inp-err" role="alert">Online sign-in is unavailable right now. Continue as guest, or message us on WhatsApp.</p>`}
    <div class="back-row"><button type="button" class="link-btn" id="gBack">← Back</button></div>`;
  const back = $("#gBack"); if (back) back.addEventListener("click", () => openMemberChoice(plan.id));
}

function stepNumber() {
  const plan = state.plan; if (!plan) return;
  const conf = state.config;
  state.step = "number";
  const isMember = Boolean(state.me);
  const price = isMember ? (plan.memberPrice||plan.sell) : (plan.guestPrice||plan.sell);
  $("#modalInner").innerHTML = `
    <h3>Who should receive the data?</h3>
    <div class="order-sum"><div><span>Bundle</span><span>${esc(humanSize(plan.sizeMb) || plan.name)} · ${esc(plan.network)}</span></div><div class="total"><span>Total</span><span>${esc(conf.currency)} ${esc(fmt(price))} ${isMember?'<small style="font-weight:600;color:#15803d">Member price</small>':''}</span></div></div>
    <div class="field"><label for="oPhone">Beneficiary number</label><input id="oPhone" type="tel" inputmode="numeric" placeholder="024XXXXXXX" autocomplete="tel" maxlength="13" value="${esc(state.phone)}" /></div>
    <div class="phone-warn">⚠️ Double-check the beneficiary number before paying. Data sent to the wrong number cannot be reversed.</div>
    <div id="netHintWrap">${phoneWarnHtml(state.phone)}</div>
    <div class="field"><label for="oEmail">Your email for receipt (optional)</label><input id="oEmail" type="email" placeholder="you@example.com" maxlength="254" value="${esc(state.email)}" /></div>
    ${state.me ? `<div class="field"><label>Saved numbers</label><div id="savedPills" class="pills"></div></div>` : ""}
    <div class="pay-actions"><button type="button" class="btn btn-primary btn-block" id="oNext">CONTINUE TO CONFIRM</button></div>
    <p class="inp-err" id="stepErr" role="alert"></p>`;
  const phoneInput = $("#oPhone");
  phoneInput.addEventListener("input", () => {
    const wrap = $("#netHintWrap"); if (wrap) wrap.innerHTML = phoneWarnHtml(phoneInput.value);
    phoneInput.classList.remove("invalid"); const err = $("#stepErr"); if (err) err.textContent = "";
  });
  if (state.me) loadSavedPills();
  const proceedToConfirm = () => {
    const phoneVal = normalizePhone(phoneInput.value);
    phoneInput.classList.remove("invalid");
    state.phone = phoneVal; state.email = $("#oEmail").value.trim();
    const err2 = $("#stepErr");
    if (state.email && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(state.email)) { err2.textContent = "That email doesn't look right. Check it or leave it blank."; return; }
    err2.textContent = ""; stepConfirm();
  };
  $("#oNext").addEventListener("click", () => {
    const phoneVal = normalizePhone(phoneInput.value);
    const err = $("#stepErr");
    if (!/^0[245][0-9]{8}$/.test(phoneVal)) { phoneInput.classList.add("invalid"); err.textContent = "Invalid phone number. Enter a valid Ghanaian mobile number (024XXXXXXX)."; phoneInput.focus(); return; }
    const g = guessNetwork(phoneVal);
    if (g && g !== plan.network) {
      let warn = document.getElementById("mismatchWarn");
      if (!warn) {
        warn = document.createElement("div");
        warn.id = "mismatchWarn";
        warn.className = "phone-warn";
        warn.style.marginTop = "12px";
        phoneInput.closest(".field").after(warn);
      }
      const art2 = (g==="MTN" || /^[AEIOU]/i.test(g)) ? "an" : "a";
      warn.innerHTML = `⚠️ This looks like ${art2} ${esc(g)} number. You selected ${esc(plan.network)}. Ported numbers keep their old prefix. Continue with ${esc(plan.network)}?<div style="display:flex;gap:8px;margin-top:10px"><button type="button" class="btn btn-primary" id="mismatchContinue">Continue with ${esc(plan.network)}</button><button type="button" class="btn btn-ghost" id="mismatchEdit">Edit number</button></div>`;
      const cont = warn.querySelector("#mismatchContinue");
      const edit = warn.querySelector("#mismatchEdit");
      if (cont) cont.onclick = () => { warn.remove(); proceedToConfirm(); };
      if (edit) edit.onclick = () => { warn.remove(); phoneInput.focus(); };
      return;
    }
    proceedToConfirm();
  });
  phoneInput.addEventListener("keydown", (e) => e.key === "Enter" && $("#oNext").click());
  phoneInput.focus();
}
async function loadSavedPills() {
  try {
    const list = await api("/api/account/saved-numbers");
    const el = $("#savedPills");
    if (!el) return;
    if (!list.length) { el.innerHTML = `<small class="dim">No saved numbers yet. Save one in your account.</small>`; return; }
    el.innerHTML = list.map(x=>`<button type="button" class="pill-net" data-phone="${esc(x.phone)}">${esc(x.label)}: ${esc(formatGh(x.phone))}</button>`).join("");
    $$("[data-phone]", el).forEach(b=>b.addEventListener("click", ()=>{ $("#oPhone").value = b.dataset.phone; $("#oPhone").dispatchEvent(new Event("input")); }));
  } catch {}
}
function stepConfirm() {
  const plan = state.plan; if (!plan) return;
  const conf = state.config;
  const isMember = Boolean(state.me);
  const price = isMember ? (plan.memberPrice||plan.sell) : (plan.guestPrice||plan.sell);
  state.step = "confirm";
  $("#modalInner").innerHTML = `
    <div class="confirm-box">
      <p class="confirm-label">Sending</p>
      <p class="confirm-main">${esc(plan.network)} ${esc(humanSize(plan.sizeMb) || plan.name)} <span class="confirm-to">to</span> <span class="confirm-phone">${esc(formatGh(state.phone))}</span></p>
      <p class="confirm-sub">Is this number correct?</p>
    </div>
    <p class="phone-warn">Check the SIM before you pay. Data cannot be reversed to a wrong number, and it is not delivered to: agent, merchant or EVD SIMs, Turbonet, broadband or WiFi-router lines, blacklisted, roaming or inactive SIMs, or a SIM with borrow credit or borrowed data (the data is wiped once it lands). The number must be on the same network as the bundle you picked. One order at a time per number, please: a second order for the same number at the same time can be rejected with no refund.</p>
    <label class="agree-row" for="agTerms">
      <input type="checkbox" id="agTerms" />
      <span>I have checked the number and the SIM, and I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/refund-policy" target="_blank" rel="noopener">Refund Policy</a>. I understand data cannot be reversed to a wrong number, that some SIMs are not eligible, and that one order at a time per number is required.</span>
    </label>
    <div class="pay-actions">
      <button type="button" class="btn btn-primary btn-block" id="oConfirm" disabled>Yes, pay ${esc(conf.currency)} ${esc(fmt(price))}</button>
      <button type="button" class="btn btn-ghost btn-block" id="oEdit">Edit number</button>
    </div>`;
  const payBtn = $("#oConfirm");
  const agree = $("#agTerms");
  const syncAgree = () => { payBtn.disabled = !agree.checked; };
  agree.addEventListener("change", syncAgree);
  syncAgree();
  payBtn.addEventListener("click", () => stepSummary());
  $("#oEdit").addEventListener("click", () => stepNumber());
}
function stepSummary() {
  const plan = state.plan; if (!plan) return;
  const conf = state.config;
  state.step = "summary";
  const isMember = Boolean(state.me);
  const price = isMember ? (plan.memberPrice||plan.sell) : (plan.guestPrice||plan.sell);
  const guestSave = !isMember ? ( (plan.guestPrice||plan.sell) - (plan.memberPrice||plan.sell) ) : 0;
  const nextUrl = `/?plan=${encodeURIComponent(plan.id)}#shop`;
  const walletBtn = state.me ? `<button type="button" class="btn btn-pay btn-block" id="oWallet">Pay with wallet: ${esc(conf.currency)} ${esc(fmt(price))} <small style="font-weight:400">(balance ${esc(conf.currency)} ${esc(fmt(state.me.wallet))})</small></button>` : `<a class="btn btn-ghost btn-block" href="/account?next=${encodeURIComponent(nextUrl)}">Sign in & pay only ${esc(conf.currency)} ${esc(fmt(plan.memberPrice||plan.sell))} (save ${esc(conf.currency)} ${esc(fmt(guestSave))}) →</a>`;
  const payEl = conf.paystackOn ? `<button type="button" class="btn btn-pay btn-block" id="oPay">PAY NOW (ONLINE)</button>${conf.unpaidEnabled ? `<button type="button" class="btn-manual btn-block" id="oManual">Pay later, I'll follow the payment note</button>` : ""}` : `<button type="button" class="btn btn-primary btn-block" id="oManual">PAY NOW</button>`;
  const badges = `<div class="pay-badges"><span class="pay-badge">Paystack</span><span class="pay-badge">MoMo</span><span class="pay-badge">Visa</span><span class="pay-badge">Mastercard</span></div>`;
  $("#modalInner").innerHTML = `
    <h3>Order summary: check before paying</h3>
    <div class="order-sum"><div><span>Bundle</span><span>${esc(humanSize(plan.sizeMb) || plan.name)}</span></div><div><span>Network</span><span>${esc(plan.network)}</span></div><div><span>Recipient</span><span>${esc(formatGh(state.phone))}</span></div><div class="total"><span>Total</span><span>${esc(conf.currency)} ${esc(fmt(price))} ${isMember?'<small style="color:#15803d">Member</small>':'<small>Guest</small>'}</span></div></div>
    <div class="pay-actions">${walletBtn}${payEl}</div>
    <p class="inp-err" id="orderErr" role="alert"></p>
    ${badges}
    <div class="back-row"><button type="button" class="link-btn" id="oBack">← Change number</button></div>`;
  let placing = false;
  function lockPay(disabled, label) {
    ["#oWallet","#oPay","#oManual"].forEach(sel=>{ const b=$(sel); if(b) { b.disabled=disabled; if(label) b.textContent=label; }});
  }
  const oBuy = async (payMode, triggerBtn) => {
    if (placing) return; placing = true;
    lockPay(true, "Placing order…");
    try {
      const res = await api("/api/order", { method: "POST", body: JSON.stringify({ planId: String(plan.id), network: plan.network, phone: state.phone, email: state.email, payMode, terms: true }) });
      if (payMode === "paystack" && res.payment && res.payment.url && res.order && res.order.id) {
        const phoneSuffix = state.phone.slice(-4);
        sessionStorage.setItem(`order_phone_${res.order.id}`, phoneSuffix);
        if (res.payment.reference) {
          sessionStorage.setItem(`order_phone_${res.payment.reference}`, phoneSuffix);
          sessionStorage.setItem(`paystack_order_${res.payment.reference}`, res.order.id);
        }
        window.location.href = res.payment.url;
        return;
      }
      $("#modalInner").innerHTML = successHtml(res, plan);
    } catch (e) { showOrderError(e.message); lockPay(false); if (triggerBtn) triggerBtn.textContent = "TRY AGAIN"; placing = false; }
  };
  const oBuyWallet = async () => {
    if (placing) return; placing = true;
    lockPay(true, "Paying…");
    try {
      const res = await api("/api/wallet/order", { method: "POST", body: JSON.stringify({ planId: String(plan.id), network: plan.network, phone: state.phone, email: state.email }) });
      if (state.me) { state.me.wallet = res.balance; renderAcct(); }
      $("#modalInner").innerHTML = walletSuccessHtml(res, plan);
    } catch (e) {
      // bug #6: clear message showing top-up amount
      const need = price - (state.me ? state.me.wallet : 0);
      const msg = /Insufficient balance/i.test(e.message) ? `${e.message}. Top up GHS ${fmt(Math.max(0, need))} more.` : e.message;
      showOrderError(msg); lockPay(false); placing = false;
    }
  };
  const wallet = $("#oWallet"); if (wallet) wallet.addEventListener("click", oBuyWallet);
  const pay = $("#oPay"); if (pay) pay.addEventListener("click", (e) => oBuy("paystack", e.currentTarget));
  const man = $("#oManual"); if (man) man.addEventListener("click", (e) => oBuy("manual", e.currentTarget));
  const back = $("#oBack"); if (back) back.addEventListener("click", stepNumber);
}
function openOrder(planId) {
  const plan = state.products.find((p) => String(p.id) === String(planId));
  if (!plan) return toast("Bundle not found", true);
  state.plan = plan; state.step = "number"; showBuyBar(plan); openMemberChoice(planId);
}
function clearPick() { state.plan = null; state.step = "number"; state.phone = ""; state.email = ""; hideBuyBar(); }
function showBuyBar(plan) {
  const bar = $("#buyBar"); if (!bar) return;
  const mp = plan.memberPrice || plan.sell;
  $("#buyBarName").textContent = `${humanSize(plan.sizeMb) || plan.name} · ${plan.network}`;
  $("#buyBarSub").textContent = `${state.config.currency} ${fmt(mp)} member`;
  bar.hidden = false;
  document.body.classList.add("has-buy-bar");
}
function hideBuyBar() { const bar = $("#buyBar"); if (bar) bar.hidden = true; document.body.classList.remove("has-buy-bar"); }
function walletSuccessHtml(res, plan) {
  const ou = res.order; const conf = state.config;
  const progressLabel = ou.progress && ou.progress.label ? ou.progress.label : "Your order is being processed.";
  return `<div class="success"><div class="check">✅</div><h3>${esc(ou.status === "delivered" ? "Payment successful" : "Order processing")}: ${esc(ou.id)}</h3>
    <p>${ou.status === "delivered" ? `Your ${esc(humanSize(plan.sizeMb) || plan.name)} bundle has been sent to ${esc(formatGh(ou.phone))}.` : esc(progressLabel)}</p>
    ${progressHtml(ou.progress)}
    <p class="dim">Amount ${esc(conf.currency)} ${esc(fmt(ou.sell))} paid from your wallet · New balance <b>${esc(conf.currency)} ${esc(fmt(res.balance))}</b></p>
    <p class="dim">Your tracking code: <b>${esc(ou.trackCode || "shown in your account")}</b></p>
    <div class="pay-actions"><button type="button" class="btn btn-ghost btn-block" id="scTrack" data-prefill="${esc(ou.trackCode || "")}">TRACK ORDER</button><button type="button" class="btn btn-primary btn-block" data-buyagain>Buy again → ${esc(formatGh(ou.phone))}</button></div>
    <button type="button" class="link-btn" data-close>Close</button></div>`;
}
function successHtml(res, plan) {
  const p = res.payment; const ou = res.order;
  if (p.type === "paystack") {
    return `<div class="success"><div class="check">🔐</div><h3>Almost done</h3><p>Complete your payment and your ${esc(humanSize(plan.sizeMb) || plan.name)} is sent to the network automatically. Delivery is usually minutes, but can take hours when a network is congested.</p><a class="btn btn-pay btn-block" href="${esc(p.url)}" target="_blank" rel="noopener">PAY NOW</a><p class="dim">Tracking code: <b>${esc(ou.trackCode || "shown in your account")}</b></p><button type="button" class="link-btn" id="scTrack" data-prefill="${esc(ou.trackCode || "")}">Track this order</button><button type="button" class="link-btn" data-close>Close</button></div>`;
  }
  const conf = state.config; const wa = conf.contact && conf.contact.whatsapp;
  return `<div class="success"><div class="check">✅</div><h3>Order placed: ${esc(ou.id)}</h3><p>${esc(p.note || "Proceed with payment to receive your data.")}</p><p class="dim">Amount: ${esc(p.currency)} ${esc(fmt(p.amount))} · Beneficiary ends ${esc(ou.phone && ou.phone.slice(-4))}</p><p class="dim">Your tracking code: <b>${esc(ou.trackCode || "shown in your account")}</b></p>${wa ? `<a class="btn btn-whatsapp btn-block" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(`Hi, I just placed data order ${ou.id}. Let me know how to pay.`)}" target="_blank" rel="noopener">SEND PAYMENT PROOF ON WHATSAPP ↗</a>` : ""}<div class="pay-actions"><button type="button" class="link-btn" id="scTrack" data-prefill="${esc(ou.trackCode || "")}">Track this order</button><button type="button" class="btn btn-primary btn-block" data-buyagain>Buy again → ${esc(formatGh(ou.phone))}</button></div><button type="button" class="link-btn" data-close>Close</button></div>`;
}
const TRACK_TMPL = (extra) => `
  <h3>Track an order</h3>
  <p class="dim">Enter the tracking code shown after your order. It looks like <b>PD-XXXXXXXXXX</b>.</p>
  <div class="field"><label for="trId">Tracking code</label><input id="trId" type="text" placeholder="PD-XXXXXXXXXX" autocomplete="off" maxlength="13" value="${extra || ""}" /></div>
  <div class="pay-actions"><button type="button" class="btn btn-primary btn-block" id="trGo">CHECK STATUS</button></div>
  <p class="inp-err" id="trErr" role="alert"></p><div id="trReport"></div>`;
function openTrack(prefillCode) { $("#modalInner").innerHTML = TRACK_TMPL(esc(prefillCode || "")); openModal(); const ti=$("#trId"); if(ti) { ti.focus(); ti.select(); } $("#trGo").addEventListener("click", () => doTrack()); $("#trId").addEventListener("keydown", (e)=> e.key==="Enter" && doTrack()); }
async function doTrack() {
  const code = $("#trId").value.trim().toUpperCase();
  const report = $("#trReport"); const err = $("#trErr");
  if (!/^PD-[A-F0-9]{10}$/.test(code)) { if (err) err.textContent = "Enter the tracking code from your order confirmation."; return; }
  if (err) err.textContent = ""; report.innerHTML = '<p class="dim">Checking…</p>';
  try {
    const o = await api("/api/order/track", { method: "POST", body: JSON.stringify({ code }) });
    const badge = statusBadge(o.status);
    report.innerHTML = `<div class="order-sum"><div><span>Order</span><span>${esc(o.id)}</span></div><div><span>Bundle</span><span>${esc(o.planName)} (${esc(o.network)})</span></div><div><span>Placed</span><span>${esc(new Date(o.created).toLocaleString())}</span></div><div><span>Amount</span><span>${esc(o.currency)} ${esc(fmt(o.sell))}</span></div><div class="total"><span>Status</span><span>${badge}</span></div></div>${progressHtml(o.progress)}${o.status === "pending" ? '<p class="dim">We have your order. If you paid, send proof on WhatsApp and we\'ll deliver.</p>' : ""}${o.status === "processing" || o.status === "paid" ? `<p class="dim">${esc(o.progress && o.progress.label ? o.progress.label : "Your data is being processed.")}</p>` : ""}${o.status === "failed" ? '<p class="phone-warn" style="margin-top:12px">This order hasn\'t been delivered. Message us on WhatsApp and we\'ll sort it out.</p><button type="button" class="btn btn-primary btn-block" data-buyagain>Buy again</button>' : ""}`;
  } catch (e) { report.innerHTML = `<p class="inp-err" style="margin-top:12px">${esc(e.message)}</p>`; }
}
function statusBadge(s) {
  const map = { pending: "Pending payment", pending_payment: "Awaiting payment", paid: "Paid, processing", processing: "Processing", delivered: "Delivered", failed: "Failed", refunded: "Refunded" };
  return `<span class="badge ${esc(s)}">${esc(map[s] || s)}</span>`;
}
function openModal() {
  const m = $("#orderModal"); m.classList.add("open"); m.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; document.body.classList.add("modal-open");
  const first = $("#modalInner input, #modalInner button"); if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
}
function closeModal() { const m = $("#orderModal"); m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; document.body.classList.remove("modal-open"); }
{
  // The mobile menu itself lives in /js/nav.js so every page shares one
  // implementation; here we only need to close it when a track action fires.
  ["#navTrack", "#heroTrack", "#footTrack"].forEach((sel) => { const el = $(sel); if (el) el.addEventListener("click", () => { $("#mainNav").classList.remove("open"); closeModal(); openTrack(""); }); });
  const closeBtn = $("#closeModal"); if (closeBtn) closeBtn.addEventListener("click", closeModal);
  const buyBarGo = $("#buyBarGo"); if (buyBarGo) buyBarGo.addEventListener("click", () => { if (state.plan) openOrder(state.plan.id); });
  const buyBarX = $("#buyBarX"); if (buyBarX) buyBarX.addEventListener("click", clearPick);
  const orderModal = $("#orderModal");
  if (orderModal) orderModal.addEventListener("click", (e) => {
    if (e.target === $("#orderModal")) closeModal();
    const closer = e.target.closest("[data-close]"); if (closer) { closeModal(); if (state.plan && state.step === "summary") clearPick(); }
    const track = e.target.closest("#scTrack"); if (track) openTrack(track.dataset.prefill || "");
    const again = e.target.closest("[data-buyagain]"); if (again) { closeModal(); if (state.plan) openOrder(state.plan.id); }
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeModal());
  // query param ?plan=ID auto-open (buy again deep link) + referral capture + hash #track
  const qp = new URLSearchParams(location.search);
  if (qp.get("plan")) { const pid = qp.get("plan"); setTimeout(()=> { if (state.products.find(p=>String(p.id)===String(pid))) openOrder(pid); }, 900); }
  if (location.hash === "#track") setTimeout(()=> openTrack(""), 600);
  window.addEventListener("hashchange", () => { if (location.hash === "#track") openTrack(""); });
  if (qp.get("ref")) try { localStorage.setItem("pending_ref", qp.get("ref")); } catch {}
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=74", { updateViaCache: "none" }).catch(()=>{});
  setupInstallPrompt();
}

/* PWA install: catch the browser prompt and offer a button. Never nag after dismissal. */
function setupInstallPrompt() {
  let deferred = null;
  const DISMISS_KEY = "pdh_install_dismissed";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) return;

  const show = () => {
    if (sessionStorage.getItem("pdh_install_open")) return;
    let btn = $("#installBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "installBtn";
      btn.className = "install-btn";
      btn.innerHTML = '<span aria-hidden="true">⬇</span> Install POLYMATH on your phone';
      // Sit it inline under the quick-buy box so it never covers the status banner.
      const anchor = $("#quickBuy") || $(".hero-copy");
      if (!anchor) return;
      anchor.insertAdjacentElement("afterend", btn);
    }
    btn.hidden = false;
    btn.onclick = async () => {
      if (!deferred) return;
      btn.disabled = true;
      try { deferred.prompt(); await deferred.userChoice; } catch {}
      deferred = null;
      btn.remove();
      try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
    };
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    let dismissed = null;
    try { dismissed = localStorage.getItem(DISMISS_KEY); } catch {}
    if (!dismissed) setTimeout(show, 2500);
  });

  window.addEventListener("appinstalled", () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
    const btn = $("#installBtn"); if (btn) btn.remove();
    if (typeof toast === "function") toast("App installed. Open POLYMATH from your home screen.");
  });
}
load();
