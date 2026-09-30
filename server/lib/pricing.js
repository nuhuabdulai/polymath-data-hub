/* Pricing: one place decides what a customer pays, floor included.
   Extracted from the single-file server so a change here cannot be confused with a
   change to the checkout routes, and so this file can be read on its own. */
const fs = require("fs");
const path = require("path");
const { cfg, dataPath } = require("./config");

const PRICING_FILE = dataPath("pricing.json");
const DEFAULT_MARKUP = Number(cfg("MARKUP_PERCENT", "15"));
const DEFAULT_GUEST_MARKUP = Number(cfg("GUEST_MARKUP_PERCENT", "55"));

const NETWORKS = ["mtn", "telecel", "airteltigo"];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const PRICING_DEFAULTS = {
  markupPercent: DEFAULT_MARKUP,
  guestMarkupPercent: DEFAULT_GUEST_MARKUP,
  minMarginPercent: Number(cfg("MIN_MARGIN_PERCENT", "5")),
  promo: { active: false, percent: 0, networks: NETWORKS, label: "", endsAt: null },
  overrides: {},
};

function loadPricing() {
  const raw = fs.existsSync(PRICING_FILE) ? JSON.parse(fs.readFileSync(PRICING_FILE, "utf8") || "{}") : {};
  const p = { ...PRICING_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  p.promo = { ...PRICING_DEFAULTS.promo, ...(raw.promo || {}) };
  if (!Array.isArray(p.promo.networks) || !p.promo.networks.length) p.promo.networks = NETWORKS;
  if (!p.overrides || typeof p.overrides !== "object") p.overrides = {};
  return p;
}

function savePricing(p) {
  fs.mkdirSync(path.dirname(PRICING_FILE), { recursive: true });
  const tmp = `${PRICING_FILE}.tmp`;
  p.updated = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, PRICING_FILE);
  return p;
}

function promoLive(promo) {
  if (!promo || !promo.active) return false;
  if (promo.endsAt && Date.parse(promo.endsAt) < Date.now()) return false;
  return true;
}

/** Resolve the price a customer pays for one plan. Never returns less than the margin floor. */
function priceFor(plan, isMember) {
  const cfgP = loadPricing();
  const cost = Number(plan.cost);
  const key = String(plan.id);
  const ov = cfgP.overrides[key];
  const promo = cfgP.promo;
  const promoApplies = promoLive(promo) && promo.networks.map((n) => String(n).toLowerCase()).includes(String(plan.network || "").toLowerCase());
  const promoPct = promoApplies ? clamp(Number(promo.percent) || 0, 0, 100) : 0;
  const markup = clamp(Number(isMember ? cfgP.markupPercent : cfgP.guestMarkupPercent) || 0, -90, 1000);
  const floorPct = clamp(Number(cfgP.minMarginPercent) || 0, 0, 1000);
  const useFloor = floorPct > 0;
  const floor = useFloor ? round2(cost * (1 + floorPct / 100)) : 0;

  let base;
  let source = "auto";
  // A pin sets the MEMBER price (your price for signed-in customers). Guests stay
  // on the guest markup so the walk-in funnel keeps its margin; use a promo to
  // discount everyone at once.
  if (isMember && ov && ov.mode === "fixed" && Number.isFinite(Number(ov.fixed)) && Number(ov.fixed) > 0) {
    base = round2(ov.fixed);
    source = "fixed";
  } else {
    base = round2(cost * (1 + markup / 100));
  }
  const afterPromo = round2(base * (1 - promoPct / 100));
  const final = round2(useFloor ? Math.max(afterPromo, floor) : afterPromo);
  return {
    price: final,
    cost,
    base,
    markupPercent: markup,
    promoPercent: promoPct,
    marginPercent: cost > 0 ? round2(((final - cost) / cost) * 100) : 0,
    source,
    floored: useFloor && afterPromo < floor,
    promoLabel: promoApplies ? (promo.label || "") : "",
  };
}

/** Member and guest prices for a plan, with the same promo/floor rules. */
function bothPrices(plan) {
  const m = priceFor(plan, true);
  const g = priceFor(plan, false);
  return { member: m.price, guest: g.price, memberInfo: m, guestInfo: g };
}

/** "Save ~26%" badge: how much cheaper member is than guest, at the median plan. */
function savePercent() {
  const p = loadPricing();
  if (p.markupPercent >= p.guestMarkupPercent) return 0;
  return Math.round((1 - (1 + p.markupPercent / 100) / (1 + p.guestMarkupPercent / 100)) * 100);
}

module.exports = { NETWORKS, round2, clamp, PRICING_DEFAULTS, loadPricing, savePricing, promoLive, priceFor, bothPrices, savePercent };
