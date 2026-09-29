# Independent review — POLYMATH DATA HUB storefront

**Reviewed:** commit `4ddc39f` ("payments storefront, published for security review"), 2026-09-29
**Scope:** the five money paths the README names, plus auth, webhooks, secrets handling and the
operator experience around them.
**Method:** full read of `server/server.js` (3,490 lines), `server/lib/*`, `public/js/*`; the existing
suite (`test/refund-safety.js`, **42/42 pass**); a new adversarial harness
(`test/supplier-send-safety.js`) that runs the real storefront against a **stub supplier** and a
**stub Paystack** and counts `POST /place-order`; and a live run of the storefront on mock data.

Nothing here was tested against real iDATA or real Paystack — every result comes from the stubs, which
is the point: the harness can kill the process mid-call, which you cannot do to production safely.

---

## Update — fixes applied

Every finding below has since been fixed on this branch, and the harness that proved the failures now
proves the fixes. The sections that follow are the original, pre-fix record — kept because a review
that quietly rewrites itself is worth less than one that says what it saw.

```
node test/supplier-send-safety.js   # was 2 passed, 6 failed  ->  now 18 passed, 0 failed
node test/refund-safety.js          # 42 passed, 0 failed     (unchanged, still green)
```

| # | Status | What changed |
|---|---|---|
| F1 | **Fixed** | `sendClaimedAt` / `sendClaimedFor` are written to disk before any owner-initiated send, in both admin routes, mirroring `autoSendTriedAt` on the automatic path. One `sendBlockedReason()` decides whether an order may be sent — supplier reference, then claim, then a bare attempt counter from pre-fix data — and the dashboard renders the button from that same decision (`sendable`), so the two cannot disagree. The only way past a claim is the new `POST /api/admin/orders/:id/clear-send-claim`, which requires the owner to name who at the supplier confirmed the order never arrived and records it on the order and in the activity trail. No timer, deliberately. |
| F2 | **Fixed** | `paystack.js` reads the key (and base URL) at call time via `currentSecret()`; `initialized()` follows. The rotation test now sees the new key on every call. |
| F3 | **Fixed** | `verifyHmac` fails closed when no secret is set; the webhook route raises a `webhook-secret-missing` security alert, `/api/health` reports `supplierWebhook: "unsigned"`, and the dashboard shows it in red. |
| F4 | **Fixed** | The refund route refuses `paid`/`processing` orders that carry a supplier reference unless the request confirms the loss explicitly (`confirmInFlight: true`, which the dashboard only sends after a confirmation that spells out the consequence). The confirmation is recorded on the order before the money moves. |
| F5 | **Fixed** | dotenv loads `server/.env` by path, and mock mode is opt-in (`IDATAGH_USE_MOCK` must be exactly `1`) at all ten call sites. `/api/health` and a dashboard banner announce mock mode and an unsigned webhook. |
| F6 | **Fixed** | The bulk-order route runs the same per-number check as the storefront and refuses the batch with the offending numbers listed, before the wallet is debited. |
| F7 | **Fixed** | `/api/admin/orders` accepts a server-side search (`q`, `status`, `limit`, `offset`) so the dashboard can find an order beyond the 60 most recent, and the UI's search box uses it and reports how many matched across all orders. Covered by checks in the supplier harness (the default window stays cheap; a search reaches order #70). |
| F8 | **Mostly fixed** | `creditTopupOnce` returns one shape; `classifyProviderResponse` trusts an explicit status over prose; `normalize()` has real field defaults; a sale at or below supplier cost now raises an alert naming the order and both figures (rather than silently changing prices, which is the owner's call). The `security.txt` placeholders are **left alone on purpose** — filling them in means inventing a security contact, which only the owner can supply. |

Two things worth knowing about the fix itself:

- **A failed send now takes two deliberate steps to retry** (release, then send) instead of one. That
  is the intended trade: a timeout is ambiguous, and the harness shows a re-press after a crash used
  to buy the bundle a second time.
- **`autoSendTriedAt` is cleared by a release.** It has to be, or an order whose automatic send failed
  could never be re-sent. That cannot restart an automatic loop: `autoApproveAndSend()` only ever acts
  on an order that is still `pending_payment`, and a failed order is not.

---

## Verdict in one paragraph

The **automatic** path is genuinely fixed. The durable-claim rule really is implemented in
`autoApproveAndSend()`, and I could not break it — two simultaneous webhook deliveries for one paid
order produced exactly **one** supplier purchase. The **human** paths (the admin's Process / Mark-paid
buttons) do not obey that same rule: they write no claim before calling the supplier, so a double
click, a client timeout retry, a second device, or a crash mid-send can buy the same bundle twice for
one payment. That is the same failure mode as the original outage, just triggered by a person instead
of a loop. Three further issues can each cost money or make the record lie: rotating the Paystack key
from the dashboard silently does nothing, the supplier webhook trusts unsigned input when its secret
is unset, and the refund route will pay a customer back while the supplier is still delivering.

**Findings: 1 critical, 2 high, 3 medium, 3 low.** Reproduction harness: `node test/supplier-send-safety.js`

> **STATUS 2026-09-29: all 8 checks in this harness now PASS (was 2 passed, 6 failed).**
> The findings below are kept as written so the reasoning stays visible. What changed:
> F1 fixed by routing every supplier send through one `claimOrderForSend()` gate;
> F2 by reading the payment key per call; F3 by failing the webhook signature check
> closed plus a boot-time alert; F4 by refusing a refund while the supplier still
> holds the order, with an explicit `confirmInFlight` override; F5 by pinning dotenv to
> `__dirname` and requiring mock mode to be opted into explicitly; F6 by checking each
> bulk row against open orders; F8 by trusting an explicit provider status before message
> text and returning a consistent shape from `creditTopupOnce`. See the README for the
> full table. Thanks — this found a real double-spend on the human-triggered paths.

---

## Findings

### F1 — CRITICAL — Admin "Process" and "Mark paid" call the supplier with no durable claim
`server/server.js:3113` (`/api/admin/orders/:id/mark-paid`) · `server/server.js:3369` (`/api/admin/orders/:id/status` with `next === "processing"`)

Both routes do the same thing:

```js
const orders = loadOrders();                 // read once
if (order.providerRef || Number(order.sendAttempts) > 0) return res.status(409)...;  // guard
order.status = "paid";
await sendOrderToSupplier(orders, order);    // money leaves here...
saveOrders(orders);                          // ...and only now is anything written
```

The guard is checked against the copy read at the top of the request, and **the write happens after
the supplier call returns**. Compare with `autoApproveAndSend()` (`server/server.js:2962`), where
`autoSendTriedAt` is written to disk *before* the call — that is what makes the automatic path safe.

Three ways this costs money, all reproduced:

| # | Situation | Expected | Actual (measured) |
|---|---|---|---|
| 1 | Two Process presses land together (`Promise.all`) | 1 purchase | **2 purchases** |
| 2 | `SIGKILL` while the supplier is answering | attempt on disk | **`sendAttempts=0`, `providerRef=null`, no claim** |
| 3 | Owner reopens after the crash and presses Process (order reads "Paid, not sent") | 1 purchase total | **2 purchases total** |

Scenario 3 needs no concurrency at all — it is the plain, reasonable thing an owner does after a
restart, and it re-buys. Scenario 1 does not require a double click either: a client that times out
while the server keeps working (the UI already tells the owner to "press again") or the same
dashboard open on a phone and a laptop both produce it. The two-tap confirm in `public/js/admin.js:915`
reduces accidents; it is not a guarantee, and it is client-side.

**Why it matters:** this is the exact class of bug that emptied the supplier wallet on 2026-09-28/29.
It is also the one the README claims is closed for every path: *"A durable claim is written to disk
before any external call that spends money."*

**Fix.** Make every spend path use the same claim as the automatic path, and make the guards read it:

```js
/* in BOTH admin send routes, before sendOrderToSupplier */
if (order.supplierSendClaimedAt || order.autoSendTriedAt) {
  return res.status(409).json({ error:
    "This order was already claimed for sending (no supplier reference came back). Check with iDATA first." });
}
order.supplierSendClaimedAt = new Date().toISOString();
order.supplierSendClaimedBy = req.admin.user;
order.status = "paid";
order.awaitingApproval = false;
saveOrders(orders);                       // claim is durable BEFORE the call
const ok = await sendOrderToSupplier(orders, order);
saveOrders(orders);
```

Then treat that claim exactly like a failed send: never auto-repeated, surfaced in the dashboard as
"claimed, supplier did not confirm", with an explicit, confirmed override for the owner after they
have asked iDATA. Do **not** clear the claim automatically on a timer — a timeout is ambiguous, which
is the principle already documented in this codebase.

*Harness assertions:* checks 1, 2 and 3 in `test/supplier-send-safety.js`.

---

### F2 — HIGH — Rotating the Paystack key from the dashboard silently does nothing
`server/lib/paystack.js:1,14` · `server/server.js:815-883`

`paystack.js` reads the key **once, at require time**:

```js
const SECRET = process.env.PAYSTACK_SECRET_KEY;        // captured at boot
...
Authorization: `Bearer ${SECRET}`,                     // every call, forever
```

The credentials screen sets `process.env.PAYSTACK_SECRET_KEY = <new>` and rewrites `.env`, but the
module's `SECRET` constant is never refreshed. Measured, with a stub recording the `Authorization`
header:

```
credentials update answered 200
authorization headers Paystack saw: ["Bearer sk_test_stub","Bearer sk_test_stub","Bearer sk_test_stub"]
```

Three consequences, worst last:

1. After a rotation, **every** Paystack API call (initialize checkout, verify, refund, refund probe)
   still uses the old key until the process restarts. Rotating a leaked key does not revoke it.
2. The route also proves the new key before saving it — but through the same stale module, so it
   authenticates with the **old** key: a typo'd or already-dead new key passes the check
   (`server/server.js:852`) and is saved as valid.
3. `verifyPaystackSignature()` (`server/server.js:2851`) reads `cfg("PAYSTACK_SECRET_KEY")` at call
   time — i.e. the **new** key — so webhook signature checks and API calls disagree about which key
   is in force. Whichever way that lands, one half of the payment path is wrong.

The iDATA client does not have this bug: it reads `cfg()` inside each function, which is exactly why
rotating the supplier key works.

**Fix** — read the secret at call time (one-line change):

```js
const currentSecret = () => process.env.PAYSTACK_SECRET_KEY || "";
const paystack = async (path, opts = {}) => {
  const SECRET = currentSecret();
  if (!SECRET) throw new Error("Paystack not configured");
  ...
```
and `function initialized() { return Boolean(currentSecret()); }`.

*Harness assertion:* check 7.

---

### F3 — HIGH — Supplier webhooks fail **open** when the signing secret is unset
`server/lib/idatagh.js:272` · `server/server.js:3432`

```js
function verifyHmac(rawBody, signature, secret) {
  if (!secret) return true;        // ← no secret means "trust anything"
  ...
}
```

`IDATAGH_WEBHOOK_SECRET` is blank in `server/.env.example`, and blank is also the default. Reproduced
with the secret unset and no signature header at all:

```
unsigned webhook answered 200; order now reads status=delivered
```

An anonymous `POST /api/idatagh/webhook` with a body naming a known order reference can mark a paid
order **delivered** (so it drops off the "never sent" alarm and off the refund-owed list) or
**failed** (so the owner is told to refund a customer who may have been served). It cannot spend
money directly, but it corrupts the only record the owner uses to decide who gets a refund — and the
same handler writes `providerRef` from whatever the caller sends.

Guessing a reference is impractical (12 hex chars, random). The realistic attack is a leaked or logged
reference, a shared hosting neighbour, or simply a mis-set `.env` on a rebuild — and the failure is
silent, which is the worst property for a money path.

**Fix.** Fail closed, and shout:

```js
function verifyHmac(rawBody, signature, secret) {
  if (!secret) return false;       // unset secret is a misconfiguration, not permission
  ...
}
```
plus, at boot, an `alertAdmin("security", ...)` and a dashboard banner when
`IDATAGH_WEBHOOK_SECRET` is empty, stating that delivery updates are not being accepted and that the
reconciler is the only thing confirming orders. (Rejecting is safe: the code already has a reconciler,
`watchStuckOrders` and manual status control, so nothing is lost by refusing unauthenticated input.)

*Harness assertion:* check 6.

---

### F4 — MEDIUM — A refund is allowed while the supplier is still delivering
`server/server.js:3222-3231`, guard list at `3262`

The only status the card-refund route refuses is `delivered`:

```js
if (order.status === "delivered") return res.status(409).json({ error: "This order was delivered..." });
```

An order that is `processing` **with a supplier reference** — i.e. iDATA has accepted it and the data
may be minutes away — is refunded. Reproduced with an order `{status:"processing", providerRef:"IDATA-99"}`:
HTTP **200**, and a real refund call to Paystack. The customer is paid back *and* receives the bundle.

`refundStateOf()` (`server/server.js:3211`) already knows this is wrong — it reports `owed: false`
when a supplier reference exists — but that rule is only applied by the read-only
`/refund-check` endpoint and the UI, not by the route that moves money.

**Fix.** Enforce the same rule server-side:

```js
const inFlight = ["paid", "processing"].includes(order.status) && Boolean(order.providerRef);
if (inFlight && req.body.confirmInFlight !== true) {
  return res.status(409).json({ error:
    "The supplier already has this order, so a refund now could pay twice. Check with iDATA, then confirm." });
}
```
Keep `failed` + `providerRef` refundable (that is a genuine unrecoverable loss) and keep the existing
"already refunded at Paystack" probe.

*Harness assertion:* check 5.

---

### F5 — MEDIUM — The documented setup ignores `server/.env`, and the missing default is "pretend to deliver"
`server/server.js:1` · `README.md` "Setup" · `server/lib/idatagh.js:146,202,258`

The README says:

```bash
cp server/.env.example server/.env
node server/server.js          # run from the repository root
```

`dotenv` resolves `.env` against **`process.cwd()`**, not against the script's directory. Run the
documented command and every setting in `server/.env` is silently ignored — verified:

```
from server/ dir -> ADMIN_USER = "owner"
from repo root  -> ADMIN_USER = undefined      ← what the README does
```

That alone gives `admin=NOT CONFIGURED` (sign-in returns 503, as it should). The dangerous half is what
happens next: with no environment loaded, `IDATAGH_USE_MOCK` falls back to **`"1"`** in
`idatagh.js` and `server.js`, and the mock supplier marks orders `delivered` immediately. A fresh
deploy following the README is a storefront that takes money, reports "Delivered successfully",
records `providerRef: MOCK-…`, and delivers nothing. `mock=ON` is printed once to the journal at boot;
nothing else in the UI blocks it.

**Fix.**
1. `require("dotenv").config({ path: require("path").join(__dirname, ".env") });`
2. Invert the mock default: mock only when explicitly opted in —
   `const mock = cfg("IDATAGH_USE_MOCK", "") === "1";` (nine call sites: `server/lib/idatagh.js:50,146,202,258`
   and `server/server.js:2333,2647,2695,3072,3488`) — so a missing variable means "not configured, refuse to
   sell" rather than "fake it".
3. Have `/api/health` and the admin banner state mock mode loudly if it is ever on.

Verified in the live preview: with the app started from `server/`, admin is configured and the store
runs as expected.

---

### F6 — MEDIUM — Bulk orders skip the supplier's one-order-per-number rule
`server/server.js:2587-2600`

`/api/wallet/order` and `/api/order` both call `recentOrderForNumber(digits, SAME_NUMBER_WINDOW_MS)`
and refuse a second open order for the same number, because *"our supplier will not honour two orders
for the same number sent at the same time: one is rejected and there is no refund."*
`/api/wallet/bulk-order` checks only for duplicates **inside its own batch** (`validatedDupes`). A
50-row bulk order can therefore contain a number that already has an open order — the customer is
charged for the whole batch, and the supplier may reject one row with no refund.

**Fix.** Run the same check per row inside the validation loop and return the existing 409 with the
offending numbers listed.

---

### F7 — LOW — The dashboard shows only the 60 most recent orders
`server/server.js:3054`

`orders.slice(-60).reverse()` — there is no pagination and no way to search older orders from the UI.
`/api/admin/summary` and the alerts still see everything, so a refund owed on order #61 is not lost,
only invisible where the owner looks first. Worth a date filter or "load older" before the order count
gets into the hundreds.

---

### F8 — LOW — Small correctness and housekeeping items

| Where | Issue | Suggested change |
|---|---|---|
| `server/server.js:440` `creditTopupOnce`, callers at `:495`, `:2200`, `:3011` | Returns bare `false` (not an object) when already credited; the callers then do `r.error`, so a future edit that lets `false` through produces an alert reading `undefined` and a log line claiming a paid top-up was not credited | Return `{ ok: false, error: "already credited" }` consistently |
| `server/lib/idatagh.js:192` `classifyProviderResponse` | Matches `fail\|reject\|cancel\|error\|declin` against the *message text* before success patterns, so a success message containing "no errors" or "cancellation window" is classified `failed` — the order is parked as unpaid-for-when-it-was-delivered | Check explicit `delivered/completed` status first; only treat message text as failure when the status is unknown/ambiguous |
| `server/lib/idatagh.js:150-166` `normalize` | `cfg("IDATAGH_FIELD_*")` defaults to `""`, and `it[""]` is `undefined` — harmless today, but a typo'd field name silently falls through to heuristic keys | Default each field name to the documented key (`package_id`, `price`, …) |
| `public/.well-known/security.txt` | Placeholder `mailto:you@example.com`, `https://example.com`, `Expires: 2027-09-24` | Fill in the real contact before this is public, or delete the file — a security.txt pointing nowhere is worse than none |
| `server/server.js:3072` `minMarginPercent: 0` | A supplier price rise can make every sale loss-making with nothing warning (already listed in the README) | Set a floor of, say, 5% and alert when `priceFor().floored` is true on a live order |

---

## What holds up (verified, not just read)

Worth saying plainly, because most of this codebase is in better shape than the average payments site
of its size:

- **`autoApproveAndSend()` is correct.** Claim written before the call, `sendLock` per order, re-read
  from disk after the lock, single caller for both webhook and reconciler. Two concurrent webhook
  deliveries → **one** supplier purchase. This is the fix the README claims, and it works.
- **The refund path is exemplary.** Probe for an existing refund at Paystack first (catches the
  hand-refunded-in-the-dashboard case, the most likely double-refund), then claim
  `refundStatus:"pending"` on disk, then call, then never retry, with the ambiguity spelled out in a
  comment. The 42-check harness covers it and passes.
- **Amounts are pinned server-side** in both the webhook and the reconciler, and compared in kobo
  before any credit or fulfilment.
- **Auto-approval defaults OFF**, and turning it on does not retroactively release parked orders.
- **Escaping discipline is real.** Every interpolation I sampled in `public/js/*.js` goes through
  `esc()`, including order ids, supplier messages and provider text.
- **Response headers are solid**: strict CSP (`default-src 'none'`, `frame-ancestors 'none'`), HSTS,
  `X-Frame-Options: DENY`, `nosniff`, permissive-less Referrer-Policy.
- **Session handling is careful**: `httpOnly` + `Secure` + `SameSite=Strict`, 8-hour TTL, timing-safe
  credential comparison, lockout keyed per IP+user, and other sessions revoked on password change.
- **No secrets, no defaults, no data in the repo**; admin refuses to exist rather than accepting a
  known password; `trust proxy: "loopback"` is the right setting for an nginx-on-the-same-host layout,
  so `req.ip` is the customer and not the proxy.
- **The comments are honest** — they name the incident, the date and the amount. That is why this
  review could be specific instead of speculative. Keep doing it.

## Agreed with the README's own "known weaknesses"

All of them are real and I would not argue the priority order, with two notes:

- *"Rate limiting is keyed on IP"* — it is, but with `trust proxy: "loopback"` behind nginx the key is
  the customer's IP, not a shared one, and `ORDER_MAX` is configurable. The carrier-grade-NAT
  complaint is about 5 orders/10 min/IP, which is a policy choice, not a bug. A per-account bucket for
  signed-in customers would fix it without weakening guest protection.
- *"All state is JSON files with no locking beyond an in-process promise chain"* — correct, and note
  that the two admin send routes do not even use the in-process chain. Fixing F1 removes most of the
  practical risk; two processes on one data dir remains a hazard worth a single `flock` or a move to
  SQLite with a unique index on `supplier_send_claim`.

---

## Suggested order of work

1. **F1** — the only finding that spends money on its own. Reuse `autoSendTriedAt`-style claims in the
   two admin routes; the harness checks 1–3 flip to PASS when it is right.
2. **F2** — one-line fix, unblocks revoking a leaked payment key.
3. **F3** — one-line fix, closes anonymous order-state writes.
4. **F4** — one guard, prevents paying twice for the same bundle.
5. **F5** — config correctness; prevents a mock storefront from being believed.
6. **F6, F7, F8** — cheap, do them while the file is open, or as the split into modules happens.

## Reproducing

```bash
node test/refund-safety.js          # 42 passed, 0 failed   (existing suite, unchanged)
node test/supplier-send-safety.js   # 2 passed, 6 failed   (this review; every failure is a finding)
```

Both harnesses run the real application against stubs, in `test/run*` (gitignored), and never touch the
network or real money. A non-zero exit from the second one means a paid order can still be bought
twice; it is intended to be run in CI and to start passing as the findings above are fixed.
