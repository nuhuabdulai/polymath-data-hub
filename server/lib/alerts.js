/* Owner-facing signal: the activity trail and the alerts that need a human.
   Extracted from the single-file server so a change here cannot be confused with a
   change to the checkout routes, and so this file can be read on its own. */
const { cfg, dataPath } = require("./config");
const { loadJson, saveJson, loadActivity } = require("./store");

const ACTIVITY_FILE = dataPath("activity.json");
const ALERTS_FILE = dataPath("alerts.json");

const ALERT_REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000;

function alertAdmin(type, msg, dedupeKey) {
  try {
    const text = String(msg).slice(0, 240);
    const now = Date.now();
    const list = loadJson(ALERTS_FILE, []);
    // The supplier watch is debounced in memory, but a restart resets that, so the
    // same warning used to be re-raised every time the service started. Suppress a
    // repeat of the same condition within the window, whatever caused it. Dedupe
    // is on the condition key, not the wording, so a balance that jitters by a few
    // pesewas does not produce a new warning either.
    const match = list.find((a) => {
      if (now - Date.parse(a.t) >= ALERT_REPEAT_WINDOW_MS) return false;
      // Match on the condition key, but fall back to the wording so rows written
      // before dedupeKey existed still suppress a repeat.
      if (dedupeKey && a.dedupeKey === dedupeKey) return true;
      return a.msg === text && a.type === type;
    });
    if (match) {
      match.count = (Number(match.count) || 1) + 1;
      match.lastAt = new Date().toISOString();
      saveJson(ALERTS_FILE, list.slice(0, 100));
      console.log(`[ALERT ${type}] repeated ${match.count}x (suppressed): ${text.slice(0, 160)}`);
      return;
    }
    list.unshift({ t: new Date().toISOString(), type, msg: text, seen: false, count: 1, dedupeKey: dedupeKey || null });
    saveJson(ALERTS_FILE, list.slice(0, 100));
  } catch (_) {}
  console.log(`[ALERT ${type}] ${String(msg).slice(0, 200)}`);
}

const loadAlerts = () => loadJson(ALERTS_FILE, []);

function collapseDuplicateAlerts() {
  try {
    const list = loadJson(ALERTS_FILE, []);
    if (!Array.isArray(list) || !list.length) return;
    const byMsg = new Map();
    const kept = [];
    for (const a of list) {
      const k = `${a.type}|${a.msg}`;
      const prev = byMsg.get(k);
      if (prev) {
        prev.count = (Number(prev.count) || 1) + (Number(a.count) || 1);
        if (String(a.t) > prev.t) prev.t = a.t;
        continue;
      }
      const row = { ...a, count: Number(a.count) || 1 };
      byMsg.set(k, row);
      kept.push(row);
    }
    if (kept.length !== list.length) {
      saveJson(ALERTS_FILE, kept);
      console.log(`[alerts] collapsed ${list.length} alerts into ${kept.length}`);
    }
  } catch (e) { console.log("[alerts] collapse skipped:", e.message); }
}

const ACTIVITY_MAX = 2000;

function activity(type, msg) {
  const list = loadActivity();
  list.unshift({ t: new Date().toISOString(), type, msg: String(msg).slice(0, 200) });
  saveJson(ACTIVITY_FILE, list.slice(0, ACTIVITY_MAX));
}

function warnIfBelowCost(plan, price, label) {
  const cost = Number(plan && plan.cost) || 0;
  const sell = Number(price) || 0;
  if (!(cost > 0)) return;
  if (sell > cost) return;
  const loss = cost - sell;
  alertAdmin("security",
    `${label} sold ${plan.name} for GHS ${sell.toFixed(2)} but the supplier charges GHS ${cost.toFixed(2)} — a loss of GHS ${loss.toFixed(2)} on this order. Either the margin floor is set to 0 in the Pricing tab, or this price was pinned below cost. Check Pricing: the floor is the safety net that stops a supplier price rise turning every sale into a loss.`,
    `below-cost:${plan.id}`);
  activity("order", `WARNING: ${label} for ${plan.name} was sold at or below supplier cost (price GHS ${sell.toFixed(2)}, cost GHS ${cost.toFixed(2)}).`);
}

module.exports = { ALERT_REPEAT_WINDOW_MS, alertAdmin, loadAlerts, collapseDuplicateAlerts, ACTIVITY_MAX, activity, warnIfBelowCost };
