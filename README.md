# POLYMATH DATA HUB — payments storefront (open for security review)

A small Node + Express storefront that sells mobile-data bundles (MTN / Telecel /
AirtelTigo) through a third-party supplier, with Paystack checkout, customer
wallets, and an admin panel.

This copy is published **for security and correctness review**. It has been
scrubbed of every real credential, phone number, customer record and internal
address. There is no `.env`, no `data/`, and no history from the real
deployment — the first commit in this repository *is* the published code.

## Why this exists

This is a real business that lost real money to a bug, twice, in one day. Both
losses came from the same root cause: **a background loop that called the
supplier repeatedly, with no durable record of "I have already paid for this
order".** The loop was well-intentioned — it existed to recover orders whose
webhook never arrived — and it was not defensive about money.

The fix, and the rules that now hold the money paths together, are the part worth
attacking. The rest is ordinary CRUD.

## The parts that move money

Five places can change money. They are the review targets.

| Where | What it does | The guarantee it must keep |
|---|---|---|
| `claimOrderForSend()` | **The only** function that may contact the supplier | Takes an in-process lock, re-reads from disk, re-checks every guard, then writes the claim **before** the call |
| `autoApproveAndSend()` | Releases a paid card order automatically | Shares the same lock and claim field as the manual paths |
| `POST /api/admin/orders/:id/refund` | Returns money to a customer | Claims the order on disk **before** calling Paystack; never auto-retries; refuses while the supplier still holds the order |
| `reconcileCardPayments()` (60s) | Releases orders whose webhook never arrived | Refuses to act unless the status is still `pending_payment`; re-reads the order from disk first |
| `reconcileCardTopups()` (60s) | Credits a wallet | Credits once, via `creditTopupOnce()`; a replayed webhook is a no-op |

### The invariant, stated once

> **A durable claim is written to disk before any external call that spends money,
> and no failure path ever retries automatically.**

The claim is the order field `autoSendTriedAt` (the name is historical — it means
"a supplier send was claimed for this order", whoever triggered it). It is never
cleared automatically, even on a timer, because a timeout is **ambiguous**: the
request may or may not have reached the provider. Retrying turns one lost sale
into two, or one customer paid twice. A claimed-but-unconfirmed order is parked
for a human, with an alert naming the order, the amount and the reference to
check.

Three independent, in-process guards back the disk claim: the `sendLock` (so two
concurrent requests cannot both proceed), the re-read from disk, and the guard
re-checks. Any one alone is insufficient — the disk claim does not stop two
processes, and the lock does not survive a restart.

## The tests

Two harnesses, 50 checks, both self-contained: they stage a private copy of the
app, run it against **stub** suppliers, and never touch the network or real money.

```bash
cd server && npm install && cd ..
node test/refund-safety.js          # 42 checks: refunds, cancels, auth
node test/supplier-send-safety.js   #  8 checks: the supplier-send claim
```

They cover the cases that actually cost money, and they are the part of this
repository most worth improving:

- a card refund that is pressed twice
- a charge the owner **already refunded by hand** in the dashboard (the most
  likely way to double-refund, and the check that happens first)
- a connection dropped *mid-refund* — the claim must survive and the retry refused
- **two concurrent "Process" presses** — must buy the bundle exactly once
- **`SIGKILL` while the supplier is answering** — the claim must already be on disk
- the owner re-opening the admin after that crash and pressing Process again
- a refund attempted while the supplier still holds the order
- an unauthenticated supplier webhook
- rotating the payment key and proving the new one is actually used
- cancelling a delivered order, or one the supplier already has
- every route without a session (must be 401)

A good next test: a claim-and-restart check across a real process boundary, not
just an in-process kill.

## What an independent review changed (2026-09-29)

`SECURITY-REVIEW.md` in this repository is an external review of the previous
commit. It found the human-triggered send paths did **not** obey the claim rule —
the same bug as the original outage, triggered by a person instead of a loop.
All eight checks it added failed; all eight pass now. Its findings are recorded
here rather than quietly fixed:

| # | Finding | Fix |
|---|---|---|
| F1 critical | Admin "Process" and "Mark paid" wrote no claim before the supplier call — a double press, a client retry, two devices, or a crash all bought the bundle twice | One `claimOrderForSend()` gate for every send path |
| F2 high | The payment key was captured at boot, so rotating a leaked key did nothing, and the rotation validated the new key using the old one | Read the key per call |
| F3 high | The supplier webhook **failed open** when its secret was unset — an anonymous POST could mark a paid order delivered or failed | Fail closed, plus a boot-time owner alert |
| F4 medium | A refund was allowed while the supplier still held the order: the customer was paid back *and* received the bundle | Refuse, with an explicit `confirmInFlight` override |
| F5 medium | `dotenv` read from the working directory, so the documented setup ignored `.env`; and mock mode defaulted ON, so a fresh deploy reported "Delivered successfully" and delivered nothing | Path pinned to `__dirname`; mock requires explicit opt-in and otherwise **refuses to sell** |
| F6 medium | Bulk orders only checked for duplicates inside their own batch, so a number with an existing open order was still bought | Per-row check against open orders |
| F8 | A success message containing "no errors" was classified as a failure; `creditTopupOnce` returned a bare `false` to callers reading `.error` | Explicit status trusted first; consistent return shape |

## Known weaknesses, stated up front

Not hidden, because a reviewer should not have to find them:

- **No automated tests outside `test/`.** The five money paths are covered; the
  rest of the surface is not.
- **All state is JSON files on disk** with no locking beyond an in-process
  promise chain. Two processes on the same file would interleave.
- **`server.js` is one large file.** A single syntax error takes the whole
  storefront down. This has happened twice. Splitting by job is the fix.
- **No margin floor is enforced by default** (`minMarginPercent: 0`), so a
  supplier price rise can make every sale loss-making with nothing warning.
- **Rate limiting is keyed on IP** and therefore punishes customers behind
  carrier-grade NAT.
- **Single supplier, no dispute route.** If the supplier disappears, there is no
  documented way to recover a balance.
- **Partial refunds are not implemented, on purpose.** A partial refund is the
  easiest way for a retry to pay twice, so the code refuses any amount it was not
  given. This is a deliberate trade, and a reasonable thing to argue with.

## Setup

```bash
npm install
cp server/.env.example server/.env     # then fill it in
node server/server.js                  # binds 127.0.0.1:4000
```

Every setting is read from `server/.env`. There are no defaults and no fallback
credentials: if the admin password is unset, sign-in returns 503 rather than
accepting a known password.

## Anonymisation

Removed from this copy, and replaced with placeholders:

- all credentials (Paystack, supplier, OAuth, admin) — the example env is blank
- the business's real phone, WhatsApp, MoMo and email addresses
- a real phone number that was hardcoded as a blocklist seed, from a real
  incident
- every customer name, phone number, order, wallet balance and payment reference
- internal hostnames, the origin IP, systemd units and nginx configuration
- two unrelated projects that share the original repository

`test/refund-safety.js` uses obviously-fake numbers (`0240000000`).

## Licence

Add one before publishing. This is placeholder text.
