/* Regression test for the "unconfigured supplier must not fake a delivery" rule.

   HISTORY, because this has now been lost twice to refactoring:

   The original bug was `useMock() || !IDATAGH_API_URL`. That means a MISSING
   configuration silently becomes a mock, and the mock answers with
   deliveryStatus "delivered" and a MOCK- reference. Combined with dotenv loading
   from process.cwd() rather than the file's own directory, a fresh deploy that
   followed the documented setup instructions became a storefront that took real
   money, told the owner "Delivered successfully", wrote MOCK-... to the order, and
   delivered nothing.

   It was fixed twice in code and silently reintroduced twice by later refactors,
   because there was no test holding it in place. This file is that test. It runs
   in a CHILD process with a clean environment so it cannot be influenced by a
   .env file, and it asserts on the module's real behaviour rather than on the
   source text, so renaming a helper does not break it.

   Run: node test/unconfigured-supplier-safety.js
*/

const { spawnSync } = require("child_process");
const path = require("path");

const ADAPTER = path.join(__dirname, "..", "server", "lib", "idatagh.js");
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
}

/* Runs a snippet against the adapter in a child process with a deliberately
   hostile environment: no API URL, no API key, no mock flag, no .env. */
function inCleanEnv(snippet) {
  const env = { PATH: process.env.PATH, HOME: "/nonexistent-so-no-env-file" };
  const r = spawnSync(process.execPath, ["-e", `
    delete process.env.IDATAGH_API_URL;
    delete process.env.IDATAGH_API_KEY;
    delete process.env.IDATAGH_USE_MOCK;
    const idatagh = require(${JSON.stringify(ADAPTER)});
    ${snippet}
  `], { env, encoding: "utf8", timeout: 20000 });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}

console.log("  --- an unconfigured supplier must never fake a delivery ---");

let r = inCleanEnv(`
  idatagh.buyBundle({ planId: 1, network: "MTN", phone: "0240000000", reference: "R1" })
    .then((v) => console.log("RESOLVED " + JSON.stringify({ d: v.deliveryStatus, ref: v.providerRef })))
    .catch((e) => console.log("REFUSED " + e.message));
`);
ok("a purchase with no supplier configured is REFUSED, not faked",
  r.out.startsWith("REFUSED"),
  r.out || r.err.split("\n").slice(-1)[0]);
ok("  and it is not reported as delivered",
  !/RESOLVED/.test(r.out) && !/"delivered"/.test(r.out),
  r.out);

r = inCleanEnv(`
  idatagh.listProducts()
    .then((v) => console.log("RESOLVED " + (Array.isArray(v) ? v.length + " products" : "")))
    .catch((e) => console.log("REFUSED " + e.message));
`);
ok("listing the catalog with no supplier configured is REFUSED",
  r.out.startsWith("REFUSED"),
  r.out || r.err.split("\n").slice(-1)[0]);

console.log("  --- the error must tell the operator how to fix it ---");
r = inCleanEnv(`
  idatagh.buyBundle({ planId: 1, network: "MTN", phone: "0240000000", reference: "R1" })
    .catch((e) => console.log("MSG " + e.message));
`);
const msg = r.out.replace(/^MSG /, "");
ok("  the message names IDATAGH_API_URL", /IDATAGH_API_URL/.test(msg), msg);
ok("  the message mentions the deliberate mock option", /IDATAGH_USE_MOCK/.test(msg), msg);

console.log("  --- a PARTIAL configuration must also refuse, not half-work ---");
r = inCleanEnv(`
  process.env.IDATAGH_API_URL = "";
  idatagh.buyBundle({ planId: 1, network: "MTN", phone: "0240000000", reference: "R1" })
    .then((v) => console.log("RESOLVED " + JSON.stringify(v.providerRef)))
    .catch((e) => console.log("REFUSED " + e.message));
`);
ok("an empty API URL string is treated as unconfigured",
  r.out.startsWith("REFUSED"),
  r.out);

r = inCleanEnv(`
  process.env.IDATAGH_API_URL = "   ";
  idatagh.buyBundle({ planId: 1, network: "MTN", phone: "0240000000", reference: "R1" })
    .then((v) => console.log("RESOLVED " + JSON.stringify(v.providerRef)))
    .catch((e) => console.log("REFUSED " + e.message));
`);
ok("a whitespace-only API URL is treated as unconfigured",
  r.out.startsWith("REFUSED"),
  r.out);

console.log("  --- but an EXPLICIT mock must still work, or nobody can develop locally ---");
const withMock = spawnSync(process.execPath, ["-e", `
  const idatagh = require(${JSON.stringify(ADAPTER)});
  idatagh.buyBundle({ planId: 1, network: "MTN", phone: "0240000000", reference: "R1" })
    .then((v) => console.log("RESOLVED " + v.providerRef))
    .catch((e) => console.log("REFUSED " + e.message));
`], {
  env: { PATH: process.env.PATH, HOME: "/nonexistent", IDATAGH_USE_MOCK: "1" },
  encoding: "utf8", timeout: 20000,
});
ok("IDATAGH_USE_MOCK=1 still returns mock data",
  withMock.stdout.includes("RESOLVED") && withMock.stdout.includes("MOCK-"),
  withMock.stdout.trim() || withMock.stderr.split("\n").slice(-1)[0]);

console.log("  --- and a configured supplier must NOT be treated as unconfigured ---");
const configured = spawnSync(process.execPath, ["-e", `
  const idatagh = require(${JSON.stringify(ADAPTER)});
  const url = require("url");
  const s = require("http").createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: true, data: { balance: 10 } }));
  });
  s.listen(0, "127.0.0.1", async () => {
    process.env.IDATAGH_API_URL = "http://127.0.0.1:" + s.address().port;
    try {
      const w = await idatagh.walletBalance();
      console.log("RESOLVED " + JSON.stringify(w && w.balance));
    } catch (e) { console.log("REFUSED " + e.message); }
    s.close();
  });
`], {
  env: { PATH: process.env.PATH, HOME: "/nonexistent" },
  encoding: "utf8", timeout: 20000,
});
ok("a configured supplier is actually called, not refused",
  configured.stdout.includes("RESOLVED"),
  configured.stdout.trim() || configured.stderr.split("\n").slice(-1)[0]);

console.log(`\n  ===== ${pass} passed, ${fail} failed =====`);
if (fail) {
  console.log("  A failure here means a storefront can take money and report a delivery");
  console.log("  that never happened. This has been broken three times; keep this test.");
}
process.exit(fail ? 1 : 0);
