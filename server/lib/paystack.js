/* The key is read AT CALL TIME, never captured at require time.
   It used to be `const SECRET = process.env.PAYSTACK_SECRET_KEY` at the top of this
   file, which meant the dashboard's key rotation wrote the new value to .env and to
   process.env while every API call — checkout, verify, refund — kept using the old
   one until the service restarted. Rotating a leaked key did not revoke it, and the
   pre-save check in /api/admin/credentials authenticated with the OLD key, so a new
   key that was already dead still passed validation. The iDATA client reads its
   credentials per call for exactly this reason; this is the same rule. */
const currentSecret = () => String(process.env.PAYSTACK_SECRET_KEY || "");

// Base URL is overridable only so the reconcilers can be tested against a stub
// instead of the live API. It is never set in production, so the live site always
// talks to Paystack. A non-empty value here must be treated as a test/staging
// setting and never committed to the server's .env.
const baseUrl = () => process.env.PAYSTACK_API_BASE || "https://api.paystack.co";

async function paystack(path, opts = {}) {
  const SECRET = currentSecret();
  const BASE = baseUrl();
  if (!SECRET) throw new Error("Paystack not configured");
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.status === false) throw new Error(data.message || `Paystack ${res.status}`);
  return data.data;
}

function initialized() {
  return Boolean(currentSecret());
}

// Returns an initialize response: { authorization_url, reference }
async function initializeOrder({ amount, email, orderId, reference, callbackPath }) {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:4000";
  return paystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      // amount in pesewas; the server always re-pins and re-checks this value
      amount: Math.round(amount * 100),
      email,
      ...(reference ? { reference } : {}),
      callback_url: {
        host: "trusted",
        url: `${base}${callbackPath || "/complete"}`,
      }.url,
      metadata: { order_id: orderId },
    }),
  });
}

async function verify(reference) {
  return paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/* Refund a transaction, in FULL only.
   This is deliberately the one function in this file that can move money OUT, so it
   is the strictest: no amount is accepted from the caller. A partial refund is a
   decision a human must make, and a partial refund is the easiest way for a retry
   loop to pay a customer twice. If the caller ever needs to refund less, that has
   to be a separate, explicitly confirmed path. */
async function refundTransaction(reference, notes = {}) {
  return paystack("/refund", {
    method: "POST",
    body: JSON.stringify({
      transaction: reference,
      ...(notes.customer_note ? { customer_note: String(notes.customer_note).slice(0, 200) } : {}),
      ...(notes.merchant_note ? { merchant_note: String(notes.merchant_note).slice(0, 200) } : {}),
    }),
  });
}

/* Has this reference already been refunded (fully or partly)? Used to make the
   admin refund button honest: a charge that is already refunded must never be
   offered for refund again, and a partially refunded charge must be reported
   rather than silently topped up. */
async function refundsFor(reference) {
  const rows = await paystack(`/refund?transaction=${encodeURIComponent(reference)}`);
  return Array.isArray(rows) ? rows : [];
}

module.exports = { initialized, initializeOrder, verify, refundTransaction, refundsFor };