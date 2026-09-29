/* Safety test for the two money-path fixes: the cancel guard and the new refund
   path. Runs against a full copy of the app with its own data dir and a STUB
   Paystack, so it can never touch production data or real money.

   Every check asserts on the order that came BACK, not on what we sent, so a
   handler that silently fails still fails the test. */
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "run");
const DATA = path.join(ROOT, "data");
const ORDERS = path.join(DATA, "orders.json");
const STUB_PORT = 4899;
const APP_PORT = 4898;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};

/* ---- stub Paystack: controllable so we can test every failure shape ---- */
let stub = { refundMode: "ok", existingRefunds: [], refundCalls: 0, verifyBody: null };

const stubServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith("/refund?transaction=")) {
      send(200, { status: true, data: stub.existingRefunds });
    } else if (req.url === "/refund") {
      stub.refundCalls++;
      if (stub.refundMode === "fail") return send(400, { status: false, message: "Refund rejected by test stub" });
      if (stub.refundMode === "boom") { req.destroy(); return; }
      send(200, { status: true, data: { id: 999001, reference: "RFN-TEST-1", status: "pending", amount: 1000 } });
    } else if (req.url.startsWith("/transaction/verify/")) {
      send(200, { status: true, data: stub.verifyBody || { status: "success", reference: req.url.split("/").pop(), amount: 1000 } });
    } else {
      send(404, { status: false, message: "no stub route" });
    }
  });
});

const write = (orders) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ORDERS, JSON.stringify(orders, null, 2)); };
const read = () => JSON.parse(fs.readFileSync(ORDERS, "utf8"));

const order = (over) => Object.assign({
  id: "TEST1", status: "paid", planName: "MTN 1GB", network: "MTN", phone: "0240000000",
  sell: 5, currency: "GHS", sendAttempts: 0, providerRef: null, created: new Date().toISOString(),
  paystackRef: "ps_ref_1", verifiedAt: new Date().toISOString(), source: "card",
}, over);

let sessionCookie = "";

async function api(method, p, body, useSession) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (useSession && sessionCookie) headers.Cookie = sessionCookie;
    const r = http.request({ host: "127.0.0.1", port: APP_PORT, path: p, method, headers },
      (res) => {
        const sc = res.headers["set-cookie"];
        if (sc) sessionCookie = sc.map((c) => c.split(";")[0]).join("; ");
        const c = [];
        res.on("data", (x) => c.push(x));
        res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {} resolve({ code: res.statusCode, body: j }); });
      });
    r.on("error", (e) => resolve({ code: 0, body: { error: e.message } }));
    /* A stubbed "connection dropped mid-refund" never answers, so every request
       gets a hard deadline. Without this the test itself hangs and proves nothing. */
    r.setTimeout(6000, () => { r.destroy(new Error("test request timed out")); });
    if (data) r.write(data);
    r.end();
  });
}

const get = (id) => read().find((o) => o.id === id);

(async () => {
  await new Promise((r) => stubServer.listen(STUB_PORT, "127.0.0.1", r));

  /* Stage a private copy of the app so the test can never touch real data, and so
     it runs from its own directory. Done here rather than in a separate setup step
     so `node test/refund-safety.js` works from a fresh clone with no arguments. */
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.cpSync(path.join(__dirname, "..", "server"), path.join(ROOT, "server"), {
    recursive: true,
    filter: (src) => path.basename(src) !== "node_modules" && path.basename(src) !== ".env",
  });
  /* Reuse the real dependency tree if it is already installed, so the test does
     not force a second npm install. */
  const realModules = path.join(__dirname, "..", "server", "node_modules");
  if (fs.existsSync(realModules)) {
    try { fs.symlinkSync(realModules, path.join(ROOT, "server", "node_modules"), "dir"); }
    catch (e) { /* a real directory is fine too; nothing to do */ }
  }

  const { spawn } = require("child_process");
  const app = spawn("node", [path.join(ROOT, "server", "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), ADMIN_USER: "t", ADMIN_PASS: "t",
      PAYSTACK_SECRET_KEY: "sk_test_stub", PAYSTACK_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
      IDATAGH_API_KEY: "stub", IDATAGH_API_URL: `http://127.0.0.1:${STUB_PORT}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stderr.on("data", (d) => { const s = String(d); if (/Error|error:/i.test(s) && !/ExperimentalWarning/.test(s)) console.log("  [app] " + s.trim().split("\n")[0]); });
  await new Promise((r) => setTimeout(r, 2500));

  const login = await api("POST", "/api/admin/login", { user: "t", pass: "t" });
  ok("admin sign-in works for the test", login.code === 200 && sessionCookie, JSON.stringify(login.body));
  if (!sessionCookie) { console.log("  cannot continue without a session"); app.kill(); stubServer.close(); return finish(); }

  console.log("\n  --- the dead button: cancel an order that is processing but never sent ---");
  write([order({ id: "PROC_NOSEND", status: "processing" })]);
  let r = await api("POST", "/api/admin/orders/PROC_NOSEND/cancel", {}, true);
  ok("cancel now works (was 409)", r.code === 200, JSON.stringify(r.body));
  ok("  and it is cancelled", get("PROC_NOSEND").status === "cancelled");
  ok("  and it records the money owed", get("PROC_NOSEND").refundOwed === true);
  ok("  and the reason says the customer paid", /refund owed/i.test(get("PROC_NOSEND").cancelReason));

  console.log("\n  --- a real sale is still protected ---");
  write([order({ id: "SOLD", status: "delivered", providerRef: "2555215", sendAttempts: 1 })]);
  r = await api("POST", "/api/admin/orders/SOLD/cancel", {}, true);
  ok("delivered order cannot be cancelled", r.code === 409, JSON.stringify(r.body));
  ok("  and is untouched", get("SOLD").status === "delivered");

  write([order({ id: "SENT", status: "processing", providerRef: "2559999", sendAttempts: 1 })]);
  r = await api("POST", "/api/admin/orders/SENT/cancel", {}, true);
  ok("order already sent cannot be cancelled", r.code === 409, JSON.stringify(r.body));
  ok("  and is untouched", get("SENT").status === "processing");

  write([order({ id: "PENDING", status: "pending", paystackRef: null, verifiedAt: null })]);
  r = await api("POST", "/api/admin/orders/PENDING/cancel", {}, true);
  ok("unpaid order still cancels", r.code === 200, JSON.stringify(r.body));
  ok("  and is NOT flagged as a refund", get("PENDING").refundOwed === undefined || get("PENDING").refundOwed === false);

  console.log("\n  --- the missing feature: refund a card customer ---");
  write([order({ id: "CARD1" })]);
  stub.existingRefunds = []; stub.refundCalls = 0; stub.refundMode = "ok";
  r = await api("POST", "/api/admin/orders/CARD1/refund", {}, true);
  ok("card refund now works", r.code === 200, JSON.stringify(r.body));
  ok("  order is refunded", get("CARD1").status === "refunded");
  ok("  refundStatus is recorded", get("CARD1").refundStatus === "refunded");
  ok("  refundOwed cleared", get("CARD1").refundOwed === false);
  ok("  Paystack was called exactly once", stub.refundCalls === 1, "calls=" + stub.refundCalls);

  r = await api("POST", "/api/admin/orders/CARD1/refund", {}, true);
  ok("second refund is refused", r.code === 409, JSON.stringify(r.body));
  ok("  and Paystack was NOT called again", stub.refundCalls === 1, "calls=" + stub.refundCalls);

  console.log("\n  --- the double-refund trap: owner already refunded by hand ---");
  write([order({ id: "CARD2" })]);
  stub.existingRefunds = [{ id: 5, status: "processed", reference: "RFN-HAND" }];
  stub.refundCalls = 0;
  r = await api("POST", "/api/admin/orders/CARD2/refund", {}, true);
  ok("recognises an existing Paystack refund", r.code === 200 && r.body.method === "already-refunded", JSON.stringify(r.body));
  ok("  and does NOT refund again", stub.refundCalls === 0, "calls=" + stub.refundCalls);
  ok("  and records the hand refund", get("CARD2").refundRef === "RFN-HAND");

  console.log("\n  --- a failed refund is never retried behind our back ---");
  write([order({ id: "CARD3" })]);
  stub.existingRefunds = []; stub.refundCalls = 0; stub.refundMode = "fail";
  r = await api("POST", "/api/admin/orders/CARD3/refund", {}, true);
  ok("failed refund reports the real reason", r.code === 502, JSON.stringify(r.body));
  ok("  marked failed, not pending", get("CARD3").refundStatus === "failed");
  ok("  order NOT left as refunded", get("CARD3").status !== "refunded");
  ok("  called exactly once (no auto-retry)", stub.refundCalls === 1, "calls=" + stub.refundCalls);
  r = await api("POST", "/api/admin/orders/CARD3/refund", {}, true);
  ok("a retry after failure needs the owner, and still does not double-pay", r.code === 502 || r.code === 409, JSON.stringify(r.body));

  console.log("\n  --- a drop mid-refund must not allow a second one ---");
  write([order({ id: "CARD4" })]);
  stub.existingRefunds = []; stub.refundCalls = 0; stub.refundMode = "boom";
  r = await api("POST", "/api/admin/orders/CARD4/refund", {}, true);
  /* code 0 is the honest result of a connection that was dropped mid-flight: the
     client never got an answer. That is the exact case where auto-retrying would
     be dangerous, so what matters is only that the server did not answer 200 and
     did not retry. */
  ok("connection drop did not report success", r.code !== 200, "code=" + r.code);
  ok("  server did not crash (still answering)", (await api("GET", "/api/admin/orders/CARD4/refund-check", null, true)).code === 200);
  const st4 = get("CARD4").refundStatus;
  ok("  durable claim exists after the drop", st4 === "pending" || st4 === "failed", "status=" + st4);
  if (st4 === "pending") {
    const again = await api("POST", "/api/admin/orders/CARD4/refund", {}, true);
    ok("  and a second attempt is refused", again.code === 409, JSON.stringify(again.body));
    ok("  Paystack was never called twice", stub.refundCalls === 1, "calls=" + stub.refundCalls);
  }

  console.log("\n  --- wallet refunds still work ---");
  fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify([{ id: "U1", name: "Test User", wallet: 0 }], null, 2));
  write([order({ id: "WAL1", status: "failed", source: "wallet", userId: "U1", paystackRef: null, verifiedAt: null })]);
  stub.refundCalls = 0;
  r = await api("POST", "/api/admin/orders/WAL1/refund", {}, true);
  ok("wallet refund works", r.code === 200 && r.body.method === "wallet", JSON.stringify(r.body));
  ok("  wallet credited", JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))[0].wallet === 5);
  ok("  no Paystack call for a wallet refund", stub.refundCalls === 0);
  r = await api("POST", "/api/admin/orders/WAL1/refund", {}, true);
  ok("  second wallet refund refused", r.code === 409, JSON.stringify(r.body));
  ok("  wallet not credited twice", JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"))[0].wallet === 5);

  console.log("\n  --- the pre-flight check the admin button will use ---");
  write([order({ id: "CHK1" })]);
  stub.existingRefunds = [];
  r = await api("GET", "/api/admin/orders/CHK1/refund-check", null, true);
  ok("refund-check says a refund is owed", r.code === 200 && r.body.owed === true, JSON.stringify(r.body));
  ok("  and gives the exact amount", r.body.amount === 5, JSON.stringify(r.body));
  stub.existingRefunds = [{ id: 9, status: "processed" }];
  r = await api("GET", "/api/admin/orders/CHK1/refund-check", null, true);
  ok("refund-check sees a hand refund and offers nothing", r.body.done === true && r.body.owed === false, JSON.stringify(r.body));

  console.log("\n  --- unauthenticated access ---");
  r = await api("POST", "/api/admin/orders/CHK1/refund", {});
  ok("refund without a session is refused", r.code === 401, "code=" + r.code);
  r = await api("GET", "/api/admin/orders/CHK1/refund-check", null);
  ok("refund-check without a session is refused", r.code === 401, "code=" + r.code);
  r = await api("POST", "/api/admin/orders/CHK1/cancel", {});
  ok("cancel without a session is refused", r.code === 401, "code=" + r.code);

  app.kill();
  stubServer.close();
  finish();
})();

function finish() {
  console.log(`\n  ===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}
