/* Admin shell harness: runs the REAL admin scripts (all nine modules plus the
   orchestrator) against a small DOM stub and drives the tab machinery the way a
   owner would: the built bar, switching tabs, the arrow keys, and the loader
   each tab dispatches. Touches no server and no data files — the fetch stub
   answers every endpoint locally — so it is safe to run at any time:
       node test/admin-shell.js
   If you change the tab registry, the grouped bar, or setTab/loadActive, run it. */
const fs = require("fs");
(async () => {
const all = new Set();
function el(tag = "div") {
  const e = {
    tag, children: [], dataset: {}, attrs: {}, _class: new Set(), handlers: {},
    textContent: "", _html: "", hidden: false, tabIndex: 0, type: "",
    get className() { return [...this._class].join(" "); },
    set className(v) { this._class = new Set(v.split(/\s+/).filter(Boolean)); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    insertAdjacentHTML(pos, html) { this._html += String(html); },
    classList: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    append(...xs) { for (const x of xs) { e.children.push(x); x.parent = e; all.add(x); } },
    appendChild(x) { e.children.push(x); x.parent = e; all.add(x); return x; },
    addEventListener(t, fn) { (e.handlers[t] ||= []).push(fn); },
    focus() { document.activeElement = e; },
    scrollIntoView() {},
    querySelector() { return el(); },
    querySelectorAll(sel) {
      if (sel !== ".admin-tab") return [];
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (c._class.has("admin-tab")) out.push(c); walk(c); });
      walk(e);
      return out;
    },
    remove() {}, closest() { return null; },
    get value() { return this._val || ""; }, set value(v) { this._val = v; },
    style: {}, title: "", disabled: false,
  };
  e.classList = {
    add: (...c) => c.forEach((x) => e._class.add(x)),
    remove: (...c) => c.forEach((x) => e._class.delete(x)),
    toggle: (c, on) => (on ? e._class.add(c) : e._class.delete(c)),
    contains: (c) => e._class.has(c),
  };
  all.add(e);
  return e;
}
const byId = {};
const docHandlers = {};
const document = {
  activeElement: null, hidden: false,
  createElement: el, body: el(),
  addEventListener(t, fn) { (docHandlers[t] ||= []).push(fn); },
  querySelector(sel) {
    const id = (sel.match(/^#([\w-]+)$/) || [])[1];
    if (id) return (byId[id] ||= el());
    return el();
  },
  querySelectorAll(sel) {
    if (sel === ".admin-tab") return [...all].filter((e) => e._class.has("admin-tab"));
    if (sel === '[role="tablist"]') return [...all].filter((e) => e.attrs.role === "tablist");
    return [];
  },
};
const fetchLog = [];
global.document = document;
global.window = { addEventListener() {}, location: { reload() {}, href: "/" } };
global.location = window.location;
global.fetch = async (path) => {
  fetchLog.push(path);
  let data;
  if (String(path).startsWith("/api/admin/pricing")) {
    data = { settings: { markup: 0, guest: 0, minMarginPercent: 0 }, promoLive: false, promoExpired: false, products: [], rows: [] };
  } else if (String(path).startsWith("/api/admin/messaging")) {
    data = { sms: { arksel: false, cloud: true }, channels: {}, notice: null };
  } else if (String(path).startsWith("/api/admin/credentials")) {
    data = { mock: true, hasKey: false, webhookSigned: true, sms: { arksel: false, cloud: true }, channels: {} };
  } else if (String(path).startsWith("/api/admin/autoapprove")) {
    data = { on: false, note: null };
  } else {
    data = {
      totalOrders: 0, pending: 0, delivered: 0, revenue: 0, customers: 0, topupPending: 0,
      wallet: { balance: 0 }, config: { apiMock: true, paystackOn: false, supplierWebhookSigned: true },
      orders: [], users: [], topups: [], logs: [], alerts: [],
    };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, ...data }) };  // ajax() exposes the BODY as .data
};
global.confirm = () => true;

const order = ["core.js","shell.js","orders.js","customers.js","topups.js","pricing.js","status.js","messaging.js","reports.js","../admin.js"];
const bundle = order.map((m) => fs.readFileSync(`public/js/admin/${m}`, "utf8")).join("\n;\n");
eval(bundle);   // one shared scope == classic scripts sharing the global lexical env

const A = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("  ok", msg); };

const lists = document.querySelectorAll('[role="tablist"]');
A(lists.length === 3, `3 tablists built (got ${lists.length})`);
A(lists.map((l) => l.attrs["aria-label"]).join(",") === "Queues,Settings,Reports", "labels Queues/Settings/Reports in order");
const tabs = document.querySelectorAll(".admin-tab");
A(tabs.length === 8, `8 tabs built (got ${tabs.length})`);
A(tabs[0].id === "tab-orders" && tabs[0].attrs["aria-controls"] === "ordersView", "tab ids + aria-controls");
A(tabs.filter((t) => t.attrs["aria-selected"] === "true").length === 1, "exactly one aria-selected");
A(tabs[0].attrs["aria-selected"] === "true" && tabs[0].tabIndex === 0, "Orders starts active, roving tabindex = 0");
A(tabs[1].tabIndex === -1, "inactive tabs are tabindex -1");

const settle = () => new Promise((r) => setTimeout(r, 10));
let mark = 0;
const since = () => fetchLog.slice(mark);

await setTab("pricing"); await settle();
const views = ["orders","users","topups","logs","messaging","status","pricing","sales"]
  .map((t) => [t, document.querySelector(`#${t}View`).hidden]);
A(views.every(([t, h]) => (t === "pricing" ? h === false : h === true)), "setTab(pricing) shows only pricingView");
A(tabs.find((t) => t.dataset.tab === "pricing").attrs["aria-selected"] === "true", "pricing aria-selected after switch");
A(since().some((p) => p.startsWith("/api/admin/pricing")), "loader dispatched: /api/admin/pricing fetched");

mark = fetchLog.length;
const settings = lists[1];
const stabs = [...settings.children];
document.activeElement = stabs[1];
settings.handlers.keydown[0]({ key: "ArrowRight", preventDefault() {}, target: stabs[1], currentTarget: settings });
await settle();
A(document.activeElement === stabs[2], "ArrowRight moves focus pricing -> messaging");
A(since().some((p) => p.startsWith("/api/admin/messaging")), "arrow activation loaded Messaging");

mark = fetchLog.length;
settings.handlers.keydown[0]({ key: "Home", preventDefault() {}, target: stabs[2], currentTarget: settings });
await settle();
A(document.activeElement === stabs[0], "Home jumps to the group's first tab");
A(since().length > 0, "Home activation fetched Status data (" + since().join(", ") + ")");

mark = fetchLog.length;
await setTab("orders"); await settle();
A(since().some((p) => p.startsWith("/api/admin/summary")), "default tab loads the orders summary");

console.log(process.exitCode ? "\nORCHESTRATOR: FAILURES" : "\nORCHESTRATOR: ALL CHECKS PASS");
process.exit(process.exitCode || 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack.split("\n")[0]); process.exit(1); });
