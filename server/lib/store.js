/* Persistence: the JSON stores, and the small switches kept beside them.
   Extracted from the single-file server so a change here cannot be confused with a
   change to the checkout routes, and so this file can be read on its own. */
const fs = require("fs");
const path = require("path");
const { cfg, dataPath, publicPath } = require("./config");

const USERS_FILE = dataPath("users.json");
const TOPUPS_FILE = dataPath("topups.json");
const ACTIVITY_FILE = dataPath("activity.json");
const ALERTS_FILE = dataPath("alerts.json");
const MAINTENANCE_FILE = dataPath("maintenance.json");
const MAINTENANCE_HTML = publicPath("maintenance.html");
const AUTOAPPROVE_FILE = dataPath("autoapprove.json");
const BLOCK_FILE = dataPath("blocked.json");
const DATA_FILE = dataPath("orders.json");   // orders.json, the one that moves money

const loadJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8") || JSON.stringify(fallback)); }
  catch { return fallback; }
};

const saveJson = (f, arr) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  // 0600 on purpose: these files hold order PII, password hashes and (in
  // user-sessions.json) bearer tokens. A 0644 data directory is readable by
  // every account on the VPS.
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);   // in case the tmp file already existed with wider rights
  fs.renameSync(tmp, f);
  try { fs.chmodSync(f, 0o600); } catch (_) {}
  return arr;
};

const loadUsers = () => loadJson(USERS_FILE, []);

const saveUsers = (u) => saveJson(USERS_FILE, u);

const loadTopups = () => loadJson(TOPUPS_FILE, []);

const saveTopups = (t) => saveJson(TOPUPS_FILE, t);

const loadActivity = () => loadJson(ACTIVITY_FILE, []);

const loadOrders = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "[]"); }
  catch { return []; }
};

const saveOrders = (orders) => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  return orders;
};

const loadBlocked = () => {
  try { return JSON.parse(fs.readFileSync(BLOCK_FILE, "utf8") || "[]"); }
  catch { return []; }
};

const saveBlocked = (list) => {
  fs.mkdirSync(path.dirname(BLOCK_FILE), { recursive: true });
  const tmp = `${BLOCK_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, BLOCK_FILE);
  return list;
};

const blockKey = (p) => String(p || "").replace(/\D/g, "").replace(/^233/, "0");

function isBlocked(phone) {
  const key = blockKey(phone);
  if (!key) return false;
  return loadBlocked().some((b) => blockKey(b.phone) === key);
}

function maintenanceState() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, "utf8") || "{}");
    if (raw && raw.on !== undefined && typeof raw.on !== "boolean") return { on: true, updatedAt: null, updatedBy: null, error: "maintenance state is invalid" };
    return { on: raw && raw.on === true, updatedAt: raw && (raw.updatedAt || null), updatedBy: raw && (raw.updatedBy || null) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { on: false, updatedAt: null, updatedBy: null };
    return { on: true, updatedAt: null, updatedBy: null, error: "maintenance state could not be read" };
  }
}

function saveMaintenance(state) {
  fs.mkdirSync(path.dirname(MAINTENANCE_FILE), { recursive: true });
  const tmp = `${MAINTENANCE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, MAINTENANCE_FILE);
  return state;
}

function maintenanceAllows(req) {
  const p = req.path;
  if (p === "/admin" || p === "/admin.html" || p === "/api/admin" || p.startsWith("/api/admin/")) return true;
  if (["/api/health", "/api/network-status", "/api/paystack/webhook", "/api/idatagh/webhook", "/api/order/status", "/sw.js", "/manifest.json", "/offline.html"].includes(p)) return true;
  return /^\/(css|js|img)\//.test(p);
}

function autoApproveState() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTOAPPROVE_FILE, "utf8") || "{}");
    if (raw && raw.on !== undefined && typeof raw.on !== "boolean") return { on: false, updatedAt: null, updatedBy: null, error: "auto-approve state is invalid" };
    return { on: raw && raw.on === true, updatedAt: (raw && raw.updatedAt) || null, updatedBy: (raw && raw.updatedBy) || null };
  } catch (e) {
    if (e && e.code === "ENOENT") return { on: false, updatedAt: null, updatedBy: null };
    return { on: false, updatedAt: null, updatedBy: null, error: "auto-approve state could not be read" };
  }
}

function saveAutoApprove(state) {
  fs.mkdirSync(path.dirname(AUTOAPPROVE_FILE), { recursive: true });
  const tmp = `${AUTOAPPROVE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTOAPPROVE_FILE);
  return state;
}

module.exports = { loadJson, saveJson, loadUsers, saveUsers, loadTopups, saveTopups, loadActivity, loadOrders, saveOrders, loadBlocked, saveBlocked, blockKey, isBlocked, maintenanceState, saveMaintenance, maintenanceAllows, autoApproveState, saveAutoApprove };
