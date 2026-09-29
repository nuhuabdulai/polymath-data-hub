/* Does every path that can spend the owner's supplier wallet spend it AT MOST ONCE
   per order?

   This is the assertion the README asks for: "assert that a supplier stub is called
   exactly once across a simulated crash-and-restart". It runs the REAL storefront
   against a STUB supplier (no network, no money, isolated data dir) and counts
   POST /place-order calls.

   Scenarios, in the order a real incident happens:

     1. double-click          two Process presses land together
     2. crash mid-send        the box dies while the supplier is answering
     3. re-press after crash  the owner, seeing "not sent", presses Process again
     4. webhook race          two webhook deliveries for the same paid order
                              (control: the webhook path is supposed to be safe)

   Every scenario asserts the invariant. A FAIL means the storefront can buy the
   same bundle twice for one payment, which is the exact outage this codebase was
   hardened against. Exits non-zero if any invariant is broken.

   Run: node test/supplier-send-safety.js
*/
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "run-supplier");
const DATA = path.join(ROOT, "data");
const ORDERS = path.join(DATA, "orders.json");
const STUB_PORT = 4897;
const APP_PORT = 4896;
const SECRET = "sk_test_supplier_safety";
const PAYSTACK_SECRET = "sk_test_stub";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};
const note = (s) => console.log(`        ${s}`);

/* ---------- stub supplier + stub Paystack, on one port ----------
   Calls are counted on ARRIVAL and tagged with the scenario that was running, so a
   slow answer to an abandoned request can never be blamed on a later scenario, and
   a request that arrives twice is visible as two arrivals. */
let stub = { delayMs: 0, paystackVerify: null, tag: "boot", arrivals: [], refundCalls: 0 };
const calls = (tag) => stub.arrivals.filter((a) => a.tag === (tag === undefined ? stub.tag : tag)).length;

const stubServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const full = req.url;
    const url = full.split("?")[0];
    /* Recorded the moment the request ARRIVES, tagged with the scenario that is
       running now. A request that was in flight when the app was killed must never
       be attributed to a later scenario. */
    if (url === "/place-order") {
      stub.arrivals.push({ tag: stub.tag, at: Date.now() });
      console.log(`  [stub supplier] place-order arrival #${stub.arrivals.length} during '${stub.tag}'`);
    }
    if (req.headers.authorization) { (stub.lastAuth = stub.lastAuth || []).push(req.headers.authorization); }
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const answer = () => {
      if (url === "/packages") {
        return send(200, { status: true, data: [
          { package_id: 1, label: "MTN 1GB (30 days)", price: 5, data_size: 1, network: "MTN" },
          { package_id: 2, label: "Telecel 5GB (30 days)", price: 25, data_size: 5, network: "Telecel" },
        ] });
      }
      if (url === "/wallet-balance") return send(200, { status: true, data: { balance: 1000 } });
      if (url === "/place-order") {
        return send(200, { status: true, order_id: `IDATA-${stub.arrivals.length}`, message: "Order accepted" });
      }
      /* Read-only probe the refund route makes before claiming. */
      if (full.startsWith("/refund?transaction=")) return send(200, { status: true, data: [] });
      if (url === "/refund") {
        stub.refundCalls++;
        return send(200, { status: true, data: { id: 1, reference: "RFN-1", status: "pending" } });
      }
      if (url.startsWith("/transaction/verify/")) {
        const ref = decodeURIComponent(full.split("/").pop());
        return send(200, { status: true, data: stub.paystackVerify || { status: "success", reference: ref, amount: 500 } });
      }
      send(404, { status: false, message: "no stub route: " + url });
    };
    if (stub.delayMs) setTimeout(answer, stub.delayMs); else answer();
  });
});

/* ---------- app under test ---------- */
let app = null;
const APP_ENV = Object.assign({}, process.env, {
  PORT: String(APP_PORT),
  ADMIN_USER: "t", ADMIN_PASS: "t",
  ADMIN_BURST_MAX: "500",
  PAYSTACK_SECRET_KEY: PAYSTACK_SECRET,
  PAYSTACK_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  IDATAGH_USE_MOCK: "0",
  IDATAGH_API_KEY: "stub",
  IDATAGH_API_URL: `http://127.0.0.1:${STUB_PORT}`,
  IDATAGH_PATH_PRODUCTS: "packages",
  IDATAGH_PATH_BUY: "place-order",
  IDATAGH_PATH_WALLET: "wallet-balance",
  IDATAGH_FIELD_ID: "package_id",
  IDATAGH_FIELD_NAME: "label",
  IDATAGH_FIELD_PRICE: "price",
  IDATAGH_FIELD_SIZE: "data_size",
  IDATAGH_FIELD_NETWORK: "network",
  IDATAGH_AUTH_MODE: "bearer",
});

function startApp() {
  app = spawn("node", [path.join(ROOT, "server", "server.js")], { env: APP_ENV, stdio: ["ignore", "pipe", "pipe"] });
  app.stderr.on("data", (d) => {
    const s = String(d);
    if (/Error/i.test(s) && !/ExperimentalWarning/.test(s)) console.log("  [app] " + s.trim().split("\n")[0]);
  });
  return app;
}
const stopApp = (sig = "SIGKILL") => new Promise((r) => { if (!app) return r(); app.once("exit", r); app.kill(sig); });

let sessionCookie = "";
async function api(method, p, body, useSession) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (useSession && sessionCookie) headers.Cookie = sessionCookie;
    const r = http.request({ host: "127.0.0.1", port: APP_PORT, path: p, method, headers }, (res) => {
      const sc = res.headers["set-cookie"];
      if (sc) sessionCookie = sc.map((c) => c.split(";")[0]).join("; ");
      const c = [];
      res.on("data", (x) => c.push(x));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {} resolve({ code: res.statusCode, body: j }); });
    });
    r.on("error", (e) => resolve({ code: 0, body: { error: e.message } }));
    r.setTimeout(15000, () => r.destroy(new Error("test request timed out")));
    if (data) r.write(data);
    r.end();
  });
}

const write = (orders) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ORDERS, JSON.stringify(orders, null, 2)); };
const read = () => JSON.parse(fs.readFileSync(ORDERS, "utf8"));
const get = (id) => read().find((o) => o.id === id);

const order = (over) => Object.assign({
  id: "TEST1", status: "paid", planName: "MTN 1GB", planId: "1", network: "MTN",
  phone: "0240000000", sell: 5, currency: "GHS", sendAttempts: 0, providerRef: null,
  created: new Date().toISOString(), reference: "ref" + Math.random().toString(16).slice(2, 12),
  source: "manual", userId: null, autoSendTriedAt: null,
}, over);

const login = () => api("POST", "/api/admin/login", { user: "t", pass: "t" });

(async () => {
  await new Promise((r) => stubServer.listen(STUB_PORT, "127.0.0.1", r));

  /* Private copy of the app, own data dir, own node_modules link. */
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(path.join(__dirname, "..", "server"), path.join(ROOT, "server"), {
    recursive: true,
    filter: (src) => path.basename(src) !== "node_modules" && path.basename(src) !== ".env",
  });
  /* The dashboard can only rotate keys when the service can write its .env. */
  fs.writeFileSync(path.join(ROOT, "server", ".env"), "ADMIN_USER=t\nADMIN_PASS=t\n", { mode: 0o600 });
  const realModules = path.join(__dirname, "..", "server", "node_modules");
  if (fs.existsSync(realModules)) {
    try { fs.symlinkSync(realModules, path.join(ROOT, "server", "node_modules"), "dir"); } catch (e) {}
  }

  startApp();
  await new Promise((r) => setTimeout(r, 2500));
  if (app.exitCode !== null) { console.log("app did not start"); process.exit(1); }
  const l = await login();
  ok("admin sign-in works for the test", l.code === 200 && !!sessionCookie, JSON.stringify(l.body));

  /* ------------------------------------------------------------------ 1 */
  console.log("\n  1. DOUBLE CLICK: two Process presses land together");
  stub.tag = "double-click"; stub.delayMs = 1200;
  write([order({ id: "DBL1" })]);
  const [a, b] = await Promise.all([
    api("POST", "/api/admin/orders/DBL1/status", { status: "processing" }, true),
    api("POST", "/api/admin/orders/DBL1/status", { status: "processing" }, true),
  ]);
  stub.delayMs = 0;
  note(`answers: ${a.code} ${JSON.stringify(a.body && a.body.error)} | ${b.code} ${JSON.stringify(b.body && b.body.error)}`);
  ok("a double press buys the bundle exactly once", calls("double-click") === 1, `supplier place-order calls = ${calls("double-click")}`);

  /* ------------------------------------------------------------------ 2 */
  console.log("\n  2. CRASH MID-SEND: the box dies while the supplier is answering");
  stub.tag = "crash"; stub.delayMs = 4000;
  write([order({ id: "CRASH1" })]);
  const inflight = api("POST", "/api/admin/orders/CRASH1/status", { status: "processing" }, true);
  await new Promise((r) => setTimeout(r, 700));      // request is out, supplier silent
  const onDiskAtCrash = get("CRASH1");
  stub.delayMs = 0;
  await stopApp("SIGKILL");                           // hard crash, no graceful shutdown
  await inflight.catch(() => {});
  note(`supplier had already received ${calls("crash")} order(s) when the box died`);
  note(`order on disk at crash: status=${onDiskAtCrash.status} sendAttempts=${onDiskAtCrash.sendAttempts} providerRef=${onDiskAtCrash.providerRef} autoSendTriedAt=${onDiskAtCrash.autoSendTriedAt}`);
  ok("the attempt is recorded on disk before the supplier is called",
    Boolean(onDiskAtCrash.autoSendTriedAt) || Number(onDiskAtCrash.sendAttempts) > 0,
    "nothing on disk says a supplier call was in flight");

  /* ------------------------------------------------------------------ 3 */
  console.log("\n  3. RE-PRESS AFTER CRASH: owner sees \"not sent\" and presses Process");
  startApp();
  await new Promise((r) => setTimeout(r, 2500));
  sessionCookie = "";
  await login();
  stub.tag = "re-press";
  const again = await api("POST", "/api/admin/orders/CRASH1/status", { status: "processing" }, true);
  note(`re-press answered ${again.code}`);
  ok("a crash mid-send does not allow a second purchase", calls("re-press") === 0,
    `the same order was bought again (supplier calls = ${calls("re-press")})`);

  /* ------------------------------------------------------------------ 4 */
  console.log("\n  4. CONTROL: the webhook path (durable claim + lock)");
  stub.tag = "webhook-race";
  await api("PUT", "/api/admin/autoapprove", { on: true }, true);
  write([order({
    id: "HOOK1", status: "pending_payment", source: "card", paystackRef: "ps_hook_1", verifiedAt: null,
  })]);
  const hookBody = JSON.stringify({ event: "charge.success", data: { reference: "ps_hook_1", amount: 500, status: "success" } });
  const sig = crypto.createHmac("sha512", PAYSTACK_SECRET).update(hookBody).digest("hex");
  const deliver = () => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: APP_PORT, path: "/api/paystack/webhook", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(hookBody), "x-paystack-signature": sig } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", () => resolve(0));
    r.write(hookBody); r.end();
  });
  const [h1, h2] = await Promise.all([deliver(), deliver()]);
  await new Promise((r) => setTimeout(r, 1500));
  note(`webhook answers: ${h1}, ${h2}`);
  ok("two webhook deliveries buy the bundle exactly once", calls("webhook-race") === 1, `supplier place-order calls = ${calls("webhook-race")}`);

  /* ------------------------------------------------------------------ 5 */
  console.log("\n  5. REFUND OF AN ORDER THE SUPPLIER ALREADY HAS");
  write([order({ id: "SENT1", status: "processing", providerRef: "IDATA-99", sendAttempts: 1, paystackRef: "ps_sent_1" })]);
  stub.paystackVerify = null; stub.refundCalls = 0;
  const ref = await api("POST", "/api/admin/orders/SENT1/refund", {}, true);
  note(`refund of a processing order the supplier already accepted answered ${ref.code}`);
  ok("a refund is refused while the supplier is still delivering", ref.code === 409 && stub.refundCalls === 0,
    `refunding here pays the customer back for data that is still on its way (code ${ref.code}, Paystack refund calls ${stub.refundCalls})`);

  /* ------------------------------------------------------------------ 6 */
  console.log("\n  6. SUPPLIER WEBHOOK WITH NO SIGNING SECRET (IDATAGH_WEBHOOK_SECRET unset)");
  write([order({ id: "HOOKX", status: "processing", providerRef: "IDATA-X", sendAttempts: 1 })]);
  const forged = JSON.stringify({ event: "order.completed", order_id: "IDATA-X", status: "completed", message: "delivered" });
  const forgedAnswer = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: APP_PORT, path: "/api/idatagh/webhook", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(forged) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", () => resolve(0));
    r.write(forged); r.end();
  });
  note(`unsigned webhook answered ${forgedAnswer}; order now reads status=${get("HOOKX").status}`);
  ok("an unsigned supplier webhook is rejected", forgedAnswer === 401 && get("HOOKX").status === "processing",
    `an anonymous POST decided the fate of a paid order (code ${forgedAnswer}, status ${get("HOOKX").status})`);

  /* ------------------------------------------------------------------ 7 */
  console.log("\n  7. ROTATING THE PAYSTACK KEY FROM THE ADMIN DASHBOARD");
  stub.tag = "rotate"; stub.lastAuth = [];
  write([order({ id: "ROT1", status: "paid", paystackRef: "ps_rot_1" })]);
  const rot = await api("PUT", "/api/admin/credentials", { current: "t", PAYSTACK_SECRET_KEY: "sk_new_rotated_key_1" }, true);
  note(`credentials update answered ${rot.code} ${JSON.stringify(rot.body && rot.body.error)}`);
  await api("POST", "/api/admin/orders/ROT1/refund", {}, true);
  await new Promise((r) => setTimeout(r, 300));
  note(`authorization headers Paystack saw: ${JSON.stringify(stub.lastAuth)}`);
  ok("after a key rotation, API calls use the NEW key",
    stub.lastAuth.length > 0 && stub.lastAuth.every((h) => h === "Bearer sk_new_rotated_key_1"),
    "the server is still spending/refunding with the key that was meant to be replaced");

  await stopApp();
  stubServer.close();
  console.log(`\n  ===== ${pass} passed, ${fail} failed =====`);
  if (fail) console.log("  A FAIL above is a way the owner can pay for the same order twice.\n");
  process.exit(fail ? 1 : 0);
})();
