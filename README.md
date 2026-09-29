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
| `POST /api/admin/orders/:id/status` | Owner-initiated supplier send | Writes a send claim on disk **before** calling the supplier; cannot send an order that already has a reference or a claim, until the owner releases it by hand |
| `POST /api/admin/orders/:id/mark-paid` | Owner confirms a manual payment and sends | Same claim, same guarantee |
| `POST /api/admin/orders/:id/clear-send-claim` | The only way to re-send after a failed or ambiguous attempt | Requires the owner to name who at the supplier confirmed the order never arrived, and records it |
| `POST /api/admin/orders/:id/refund` | Returns money to a customer | Claims the order on disk **before** calling Paystack; never auto-retries |
| `reconcileCardPayments()` (60s) | Releases orders whose webhook never arrived | Refuses to act unless the status is still `pending_payment`; re-reads the order from disk first |
| `reconcileCardTopups()` (60s) | Credits a wallet | Credits once, via `creditTopupOnce()`; a replayed webhook is a no-op |

### The invariant, stated once

> **A durable claim is written to disk before any external call that spends money,
> and no failure path ever retries automatically.**

`autoSendTriedAt` is the claim for the automatic supplier send, and `sendClaimedAt`
is the claim for a send the owner started by hand (both are set on the automatic
path). `refundStatus: "pending"` is the claim for the refund. They are checked by
every path that can act, so a retry loop, a double click, a crash or a restart all
land on "already handled".

The claim is deliberately not cleared by a timer. A timeout is ambiguous: the
request may or may not have reached the supplier, so repeating it can buy the same
bundle twice. A human releases it, in the dashboard, after asking the supplier —
`POST /api/admin/orders/:id/clear-send-claim`, which requires the name of whoever
confirmed it and is recorded in the activity trail.

The reason a failure is never auto-retried is specific, not general caution: a
timeout is **ambiguous**. The request may or may not have reached the provider.
Retrying turns one lost sale into two, or one customer paid twice. So a failure
is parked for a human, with an alert naming the order, the amount and the
reference to check.

## The tests

Two self-contained harnesses, each running an isolated copy of the app against
**stubs**. Neither touches real money and neither needs the network.

```bash
npm install
node test/refund-safety.js          # 42 checks: refunds, cancels, sessions
node test/supplier-send-safety.js   # 18 checks: can one payment buy two bundles?
```

`test/supplier-send-safety.js` exists to answer one question that a code read
cannot: it counts `POST /place-order` at the supplier across the ways a real
storefront spends money twice — a double press, a crash mid-send, a re-press after
a restart, two webhook deliveries at once, a refund of an order the supplier is
still working on, an unsigned supplier webhook, and a key rotation. It also proves
the release path sends an order exactly once and no more, and that an order outside
the dashboard's recent window can still be found. A failure in this file is a way
the owner pays twice, so it is meant to run in CI.

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
  supplier price rise can make every sale loss-making. A sale at or below supplier
  cost now raises an alert naming the order and both figures, rather than changing
  prices behind the owner's back — raising the floor stays their decision.
- **A send claim blocks a legitimate retry until the owner releases it.** That is
  the point (a timeout is ambiguous), but it means a failed send now takes two
  deliberate steps to retry instead of one.
- **Rate limiting is keyed on IP** and therefore punishes customers behind
  carrier-grade NAT.
- **Single supplier, no dispute route.** If the supplier disappears, there is no
  documented way to recover a balance.
- **Partial refunds are not implemented, on purpose.** A partial refund is the
  easiest way for a retry to pay twice, so the code refuses any amount it was not
  given. This is a deliberate trade, and a reasonable thing to argue with.

## Running it

`DEPLOY.md` is the operations half: systemd unit, nginx config, TLS, the deploy gate
(`scripts/deploy.sh` — preflight, restart, health check, automatic rollback), nightly
backups and restore drill, and a table of what to do when something is wrong. The short
version of the one that matters:

```bash
git pull && sudo bash scripts/deploy.sh     # never `git pull && systemctl restart`
```

## Setup

```bash
npm install
cp server/.env.example server/.env     # then fill it in
node server/server.js                  # binds 127.0.0.1:4000
```

`server/.env` is read from the `server/` directory, so it does not matter which
directory you start the process from. This used to matter: the file was resolved
against the working directory, so the documented command started the site with no
settings at all — and, because the mock supplier used to be the default, it looked
like a working storefront that "delivered" nothing. The mock is now opt-in
(`IDATAGH_USE_MOCK=1`), and `/api/health` plus a dashboard banner say so loudly when
it is on.

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
