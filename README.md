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
| `autoApproveAndSend()` | Sends a paid order to the supplier | One supplier purchase per order, **ever** |
| `POST /api/admin/orders/:id/status` | Owner-initiated supplier send | Cannot send an order that already has a supplier reference |
| `POST /api/admin/orders/:id/refund` | Returns money to a customer | Claims the order on disk **before** calling Paystack; never auto-retries |
| `reconcileCardPayments()` (60s) | Releases orders whose webhook never arrived | Refuses to act unless the status is still `pending_payment`; re-reads the order from disk first |
| `reconcileCardTopups()` (60s) | Credits a wallet | Credits once, via `creditTopupOnce()`; a replayed webhook is a no-op |

### The invariant, stated once

> **A durable claim is written to disk before any external call that spends money,
> and no failure path ever retries automatically.**

`autoSendTriedAt` is the claim for the supplier send. `refundStatus: "pending"`
is the claim for the refund. Both are checked by every path that can act, so a
retry loop, a double click, a crash or a restart all land on "already handled".

The reason a failure is never auto-retried is specific, not general caution: a
timeout is **ambiguous**. The request may or may not have reached the provider.
Retrying turns one lost sale into two, or one customer paid twice. So a failure
is parked for a human, with an alert naming the order, the amount and the
reference to check.

## The tests

`test/refund-safety.js` is a self-contained harness: 42 checks against a **stub**
Paystack on an isolated copy of the app. It never touches real money and never
needs the network.

```bash
npm install
node test/refund-safety.js
```

It covers the cases that actually cost money, and it is the part of this
repository most worth improving:

- a card refund that is pressed twice
- a charge the owner **already refunded by hand** in the dashboard (the most
  likely way to double-refund, and the check that happens first)
- a provider call that fails
- a connection dropped *mid-refund* — the claim must survive and the retry must
  be refused
- cancelling a delivered order, or one the supplier already has (must be refused)
- every route without a session (must be 401)

A single assertion that would have caught the original outage, and a good place
to start: assert that a supplier stub is called **exactly once** across a
simulated crash-and-restart.

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
