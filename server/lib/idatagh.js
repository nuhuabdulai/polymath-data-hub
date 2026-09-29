const crypto = require("crypto");

const cache = { products: { at: 0, data: null }, ttlMs: Number(cfg("IDATAGH_CACHE_TTL_MS", "600000") || "600000") };
const mockDelay = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/* iDATA place-order expects the network EXACTLY as it appears in the catalog
   (e.g. "MTN", "TELECEL", "AIRTELTIGO"); lowercase slugs get 404 variation_not_found. */
const NETW_RAW = {};
const NETW_FALLBACK = { mtn: "MTN", airteltigo: "AIRTELTIGO", telecel: "TELECEL" };

function cfg(key, fallback = "") {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

const P_PATH = cfg("IDATAGH_PATH_PRODUCTS", "packages");
const P_BUY = cfg("IDATAGH_PATH_BUY", "place-order");
const P_WALLET = cfg("IDATAGH_PATH_WALLET", "wallet-balance");
const P_WEBHOOK = cfg("IDATAGH_PATH_WEBHOOK", "webhook-settings");
// If P_PATH contains "{network}" the catalog is fetched once per network
// (iDATA exposes /packages?network=mtn|telecel|airteltigo).
const NETWORKS = cfg("IDATAGH_NETWORKS", "mtn,telecel,airteltigo")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// 1 = the SIZE field value is in GB (iDATA data_size); 0/blank = already MB
const SIZE_GB = cfg("IDATAGH_SIZE_GB", "1") === "1";

function mockProducts() {
  const base = [
    { id: "mtn-1", name: "MTN 500MB (30 days)", price: 4.5, sizeMb: 500, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "mtn-2", name: "MTN 1GB (30 days)", price: 7.5, sizeMb: 1024, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "mtn-3", name: "MTN 2GB (30 days)", price: 13.5, sizeMb: 2048, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "mtn-4", name: "MTN 5GB (30 days)", price: 30, sizeMb: 5120, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "mtn-5", name: "MTN 10GB (30 days)", price: 55, sizeMb: 10240, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "mtn-6", name: "MTN 20GB (30 days)", price: 100, sizeMb: 20480, validity: "30 days", network: "MTN", slug: "mtn" },
    { id: "atl-1", name: "AirtelTigo 1GB (30 days)", price: 7, sizeMb: 1024, validity: "30 days", network: "AirtelTigo", slug: "airteltigo" },
    { id: "atl-2", name: "AirtelTigo 2GB (30 days)", price: 13, sizeMb: 2048, validity: "30 days", network: "AirtelTigo", slug: "airteltigo" },
    { id: "atl-3", name: "AirtelTigo 5GB (30 days)", price: 29, sizeMb: 5120, validity: "30 days", network: "AirtelTigo", slug: "airteltigo" },
    { id: "atl-4", name: "AirtelTigo 10GB (30 days)", price: 54, sizeMb: 10240, validity: "30 days", network: "AirtelTigo", slug: "airteltigo" },
    { id: "tcl-1", name: "Telecel 1GB (30 days)", price: 7.5, sizeMb: 1024, validity: "30 days", network: "Telecel", slug: "telecel" },
    { id: "tcl-2", name: "Telecel 2GB (30 days)", price: 13.5, sizeMb: 2048, validity: "30 days", network: "Telecel", slug: "telecel" },
    { id: "tcl-3", name: "Telecel 5GB (30 days)", price: 30, sizeMb: 5120, validity: "30 days", network: "Telecel", slug: "telecel" },
    { id: "tcl-4", name: "Telecel 10GB (30 days)", price: 55, sizeMb: 10240, validity: "30 days", network: "Telecel", slug: "telecel" },
  ];
  return base.map((p, i) => ({ ...p, id: i + 1, cost: num(p.price) }));
}

/* ---------- low level ---------- */
async function send(method, path, body) {
  const base = cfg("IDATAGH_API_URL");
  if (!base || cfg("IDATAGH_USE_MOCK", "") === "1") return null;
  const headers = {};
  const headersInit = () => {
    if (!headers.Authorization && !headers[cfg("IDATAGH_AUTH_HEADER") || "X-Api-Key"]) {
      const mode = cfg("IDATAGH_AUTH_MODE", "header");
      const value = cfg("IDATAGH_API_KEY");
      if (mode === "bearer") headers.Authorization = `Bearer ${value}`;
      else if (mode === "header") headers[cfg("IDATAGH_AUTH_HEADER") || "X-Api-Key"] = value;
      else if (mode === "query") url += `${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(value)}`;
    }
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    return headers;
  };
  const url = `${base}/${path}`;
  let payload;
  if (cfg("IDATAGH_AUTH_MODE") === "json") payload = { ...(body || {}), api_key: cfg("IDATAGH_API_KEY") };
  else payload = body;
  const res = await fetch(url, {
    method,
    headers: headersInit(),
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data;
  try { data = await res.json(); } catch (e) { data = { raw: await res.text() }; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("iDATA authentication failed. Check IDATAGH_API_KEY and the auth mode.");
    if (res.status === 404) throw new Error(`iDATA endpoint not found: ${base}/${path}. Set IDATAGH_PATH_* correctly.`);
    throw new Error(`iDATA ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

function num(v) {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function pretty(net) {
  const n = String(net || "").toLowerCase().replace(/[\s\-/]/g, "");
  if (!n) return "MTN";
  if (n.includes("airtel")) return "AirtelTigo";
  if (n.includes("telecel") || n.includes("vodafone") || n.includes("tigo")) return "Telecel";
  if (n.startsWith("mtn") || n.includes("+mtn")) return "MTN";
  return String(net);
}

function slugify(net) {
  const n = String(net || "").toLowerCase().replace(/[\s\-/]/g, "");
  if (n.includes("airtel")) return "airteltigo";
  if (n.includes("telecel") || n.includes("vodafone")) return "telecel";
  if (n.startsWith("mtn")) return "mtn";
  /* NEVER fall back to a network here. It used to return "mtn" for anything
     unrecognised, including an empty value, so a caller that forgot to pass the
     network silently bought MTN data for a Telecel or AirtelTigo order. The
     customer paid, the supplier charged us, and the data could not even run on
     their SIM. A missing network must be an error, never a guess. */
  return n;
}

function fmtSize(mb) {
  if (!(mb > 0)) return "";
  return mb >= 1024 ? `${+(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`;
}

/* ---------- mapping idatagh JSON -> our model ---------- */
/* Default field names, so an env entry that is present but blank (or a typo'd key)
   falls back to the documented iDATA names instead of to `it[""]`, which is always
   undefined and silently pushes every bundle onto the heuristic fallbacks. */
const FIELD_DEFAULTS = { ID: "package_id", LABEL: "label", NAME: "label", PRICE: "price", SIZE: "data_size", VALIDITY: "", NETWORK: "network" };

function normalize(raw, networkOverride = "") {
  const F = (k) => cfg(`IDATAGH_FIELD_${k}`, FIELD_DEFAULTS[k] || "");
  let items = Array.isArray(raw) ? raw : raw && (raw.packages || raw.data || raw.products || raw.plans || raw.list || raw.result);
  if (!Array.isArray(items)) items = raw && Array.isArray(raw.data) ? raw.data : [];
  return items.map((it) => {
    const id = it[F("ID")] ?? it.id ?? it.package_id ?? it.plan_id;
    if (id === undefined || id === null || id === "") return null;
    const sizeRaw = num(it[F("SIZE")] ?? it.size_mb ?? it.data_size ?? it.size ?? it.mb);
    const sizeMb = SIZE_GB ? sizeRaw * 1024 : sizeRaw;
    const netRaw = String(it[F("NETWORK")] ?? it.network ?? it.provider ?? networkOverride ?? "").trim();
    const network = netRaw ? pretty(netRaw) : pretty(networkOverride || "MTN");
    if (netRaw && !it[F("NETWORK")] && !it.network && !it.provider) NETW_RAW[slugify(netRaw)] = netRaw;
    let name = String(it[F("NAME")] ?? it.name ?? it.title ?? "");
    if (!name || /^[\d.]+$/.test(name.trim())) name = sizeMb ? `${network} ${fmtSize(sizeMb)}` : `${network} plan ${id}`;
    const validity = String(it[F("VALIDITY")] ?? it.validity ?? it.days ?? it.expiry ?? "");
    return {
      id: String(id),
      name,
      variant: String(it.label ?? it[cfg("IDATAGH_FIELD_LABEL")] ?? ""),
      cost: num(it[F("PRICE")] ?? it.price ?? it.amount ?? it.cost),
      sizeMb,
      validity: validity && /^(null|undefined|none)$/i.test(validity) ? "" : validity,
      network,
      slug: slugify(network || networkOverride),
    };
  }).filter(Boolean);
}

/* ---------- high level ---------- */
async function listProducts() {
  const mock = cfg("IDATAGH_USE_MOCK", "") === "1" || !cfg("IDATAGH_API_URL");
  if (mock) { await mockDelay(); return mockProducts(); }
  if (Date.now() - cache.products.at < cache.ttlMs && cache.products.data) return cache.products.data;
  const fan = P_PATH.includes("{network}");
  const nets = fan ? NETWORKS : [""];
  const all = [];
  let lastErr = null;
  for (const net of nets) {
    try {
      const path = fan ? P_PATH.replaceAll("{network}", encodeURIComponent(net)) : P_PATH;
      const dataRaw = await send("GET", path);
      if (dataRaw && typeof dataRaw === "object" && typeof dataRaw.network === "string" && dataRaw.network) {
        NETW_RAW[net || slugify(dataRaw.network)] = dataRaw.network;
      }
      all.push(...normalize(dataRaw, net || ""));
    } catch (e) { lastErr = e; }
  }
  if (!all.length) {
    if (lastErr) throw lastErr;
    throw new Error("iDATA returned no bundles for the configured endpoint/fields.");
  }
  cache.products = { at: Date.now(), data: all };
  return all;
}

function rawField(raw, names) {
  const containers = [raw, raw && (raw.data || raw.payload || raw.result)].filter(Boolean);
  for (const container of containers) {
    for (const name of names) {
      if (container[name] !== undefined && container[name] !== null && container[name] !== "") return container[name];
    }
  }
  return null;
}

function providerStatus(raw) {
  const value = rawField(raw, ["status", "order_status", "orderStatus", "state", "status_label", "statusLabel"]);
  if (typeof value === "boolean") return value ? "success" : "failed";
  return String(value || "").toLowerCase();
}

function providerMessage(raw) {
  const value = rawField(raw, ["message", "msg", "status_message", "statusMessage", "description", "detail"]);
  return String(value || "Order accepted; waiting for iDATA to start processing.").slice(0, 300);
}

function classifyProviderResponse(raw) {
  const status = providerStatus(raw);
  const message = providerMessage(raw);
  const messageText = message.toLowerCase();
  /* The explicit status wins over prose. This used to test the failure words first
     against BOTH the status and the message, so a success whose message mentioned
     an error ("delivered, no errors") or a cancellation window was classified as
     failed — parking a delivered order as one the customer paid for and never got.
     A status we recognise is taken at its word; message text is only consulted when
     the status says nothing useful. */
  if (status) {
    if (/fail|reject|cancel|error|declin/.test(status)) return "failed";
    if (/deliver|complete|fulfil|success|approv|accept/.test(status)) {
      return /deliver|complete|fulfil/.test(status) ? "delivered" : "processing";
    }
  }
  if (/fail|reject|cancel|error|declin/.test(messageText)) return "failed";
  if (/delivered|completed|fulfilled/.test(messageText)) return "delivered";
  return "processing";
}

async function buyBundle({ planId, network, phone, reference }) {
  const mock = cfg("IDATAGH_USE_MOCK", "") === "1" || !cfg("IDATAGH_API_URL");
  if (mock) {
    await mockDelay(700);
    const plan = mockProducts().find((p) => String(p.id) === String(planId));
    if (!plan) throw new Error("Plan not found");
    return {
      status: true, deliveryStatus: "delivered", providerStatus: "delivered",
      reference: `MOCK-${reference}`, providerRef: `MOCK-${reference}`,
      message: `Mock delivery started for ${phone}`, plan: plan.name, recipient: phone,
    };
  }
  const FPH = cfg("IDATAGH_BUY_PHONE", "beneficiary");
  const FPL = cfg("IDATAGH_BUY_PLAN", "plan");
  const FNE = cfg("IDATAGH_BUY_NETWORK", "network");
  const FRF = cfg("IDATAGH_BUY_REFERENCE", "");
  const slug = slugify(network);
  /* Refuse to buy rather than guess. iDATA rejects a package that does not belong
     to the network sent with it, but the exact wording of that refusal varies, and
     a silent wrong-network purchase costs real money and delivers nothing the
     customer can use. An unknown network is refused here, before any charge. */
  if (!slug || !NETW_FALLBACK[slug]) {
    throw new Error(`Refusing to buy: the order has no usable network (got ${JSON.stringify(network)}). The customer has paid and has no data — fix the order or refund them.`);
  }
  const orderNetwork = NETW_RAW[slug] || NETW_FALLBACK[slug] || slug;
  const plan = (cache.products.data || []).find((p) => String(p.id) === String(planId));
  if (!plan) throw new Error(`Refusing to buy: bundle ${planId} is not in the live catalogue, so the network cannot be confirmed.`);
  /* The catalogue is per network, so the plan we matched must itself belong to the
     network the customer paid for. Catching a mismatch here is what turns a silent
     wrong-network purchase into a loud, refundable failure. */
  const planNet = slugify(plan.network);
  if (planNet && planNet !== slug) {
    throw new Error(`Refusing to buy: this is a ${plan.network} bundle but the order is for ${network}. Nothing was charged. Refund the customer.`);
  }
  const buyId = (plan && plan.variant) || planId;
  const body = {};
  if (FPL) body[FPL] = buyId;
  if (FPH) body[FPH] = phone;
  if (FNE) body[FNE] = orderNetwork;
  if (FRF && reference) body[FRF] = reference;
  const raw = await send("POST", P_BUY, body);
  const providerRef = rawField(raw, ["order_id", "orderId", "id", "reference", "reference_code", "referenceCode"]);
  const deliveryStatus = classifyProviderResponse(raw);
  return {
    status: deliveryStatus === "delivered",
    deliveryStatus,
    providerStatus: providerStatus(raw),
    reference: providerRef,
    providerRef,
    message: providerMessage(raw),
    plan: providerRef ? String(providerRef) : planId,
    recipient: phone,
    raw,
  };
}

async function walletBalance() {
  const mock = cfg("IDATAGH_USE_MOCK", "") === "1" || !cfg("IDATAGH_API_URL");
  if (mock) return { balance: 0, raw: null };
  const data = await send("GET", P_WALLET);
  const b = data && (data.balance ?? data.wallet ?? (data.data && data.data.balance));
  return { balance: num(b), raw: data };
}

async function registerWebhook(url) {
  if (cfg("IDATAGH_USE_MOCK", "") === "1" || !cfg("IDATAGH_API_URL")) return { mock: true };
  return send("POST", P_WEBHOOK, { webhook_url: url });
}

/* HMAC-SHA256 signature check for incoming webhooks (X-Tera-Signature).
   FAILS CLOSED. It used to `return true` when no secret was configured, so on any
   install where IDATAGH_WEBHOOK_SECRET was unset (it is blank in the example env)
   an anonymous POST could mark a paid order delivered or failed — silently editing
   the record the owner uses to decide who gets a refund. An unset secret is a
   misconfiguration, not permission, so the answer is no; the boot alert and the
   dashboard say why. */
function verifyHmac(rawBody, signature, secret) {
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", String(secret)).update(rawBody || Buffer.from("")).digest("hex");
  const got = String(signature || "");
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* Drop the cached catalog. Called when the supplier credentials change from the
   admin, so a newly pasted API key is used immediately instead of after the
   normal cache window, and a bad paste is spotted straight away. */
function clearCache() {
  cache.products = { at: 0, data: null };
  return true;
}

module.exports = {
  listProducts, buyBundle, walletBalance, registerWebhook, verifyHmac, clearCache,
  normalize, mockProducts, pretty, slugify, classifyProviderResponse, providerStatus, providerMessage,
};