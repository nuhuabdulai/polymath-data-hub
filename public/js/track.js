/* Track your order - standalone page, no account required.
   Kept separate from app.js on purpose: a person chasing an order is often on a
   slow phone and a poor connection, and this page is tiny so it answers fast
   even when the storefront bundle would not have finished loading. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
      /* Strip bidi controls: a name must never be able to render backwards and
         disguise itself (E5, RLO and friends). */
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  };

  var form = $("#trackForm"), codeIn = $("#trId"), last4In = $("#trLast4");
  var last4Wrap = $("#last4Wrap"), err = $("#trErr"), report = $("#trReport"), go = $("#trGo");
  if (!form) return;

  var year = $("#year"); if (year) year.textContent = String(new Date().getFullYear());

  var WA = "https://wa.me/233502832593";
  fetch("/api/config").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    if (!c) return;
    var wa = document.getElementById("waBtn");
    if (wa && c.whatsapp && c.whatsapp.phone) {
      wa.href = "https://wa.me/" + String(c.whatsapp.phone).replace(/\D/g, "") + "?text=" +
        encodeURIComponent("Hi, I need help tracking an order.");
      wa.hidden = false;
    }
  }).catch(function () { /* the page still works without WhatsApp */ });

  function badge(s) {
    var map = { pending: "Pending payment", pending_payment: "Awaiting payment",
                paid: "Paid, processing", processing: "Processing", delivered: "Delivered",
                failed: "Failed", refunded: "Refunded", cancelled: "Cancelled" };
    return '<span class="badge ' + esc(s) + '">' + esc(map[s] || s) + "</span>";
  }

  function progressSteps(p) {
    if (!p || !p.steps) return "";
    var out = '<ol class="track-steps">';
    (p.steps || []).forEach(function (st) {
      var cls = st.done ? " done" : (st.current ? " current" : "");
      out += '<li class="' + cls.trim() + '"><span class="dot" aria-hidden="true"></span>' +
             '<span class="txt">' + esc(st.label) + "</span>" +
             (st.done ? '<span class="sr-only">(done)</span>' : "") + "</li>";
    });
    return out + "</ol>";
  }

  function fail(msg) {
    if (err) err.textContent = msg;
    report.innerHTML = "";
  }

  function show(o) {
    if (err) err.textContent = "";
    var note = "";
    if (o.status === "pending") {
      note = '<p class="dim">We have your order. If you have paid, send proof on WhatsApp and we will deliver it.</p>';
    } else if (o.status === "paid" || o.status === "processing") {
      note = '<p class="dim">' + esc((o.progress && o.progress.label) || "Your data is being processed.") + "</p>";
    } else if (o.status === "failed") {
      note = '<p class="phone-warn" style="margin-top:12px">This order has not been delivered. Message us on WhatsApp and we will sort it out.</p>';
    }
    var again = '<a class="btn btn-primary btn-block" href="/">Buy again</a>';
    report.innerHTML =
      '<div class="order-sum">' +
        '<div><span>Order</span><span>' + esc(o.id) + "</span></div>" +
        '<div><span>Bundle</span><span>' + esc(o.planName) + " (" + esc(o.network) + ")</span></div>" +
        '<div><span>Placed</span><span>' + esc(new Date(o.created).toLocaleString()) + "</span></div>" +
        '<div><span>Amount</span><span>' + esc(o.currency) + " " + esc(Number(o.sell).toFixed(2)) + "</span></div>" +
        '<div class="total"><span>Status</span><span>' + badge(o.status) + "</span></div>" +
      "</div>" + progressSteps(o.progress) + note +
      '<div class="pay-actions" style="margin-top:16px">' +
        '<a class="btn btn-whatsapp btn-block" href="' + WA + '?text=' +
          encodeURIComponent("Hi, about order " + o.id + " (tracking " + o.id + ")") +
          '" target="_blank" rel="noopener">Ask about this order on WhatsApp</a>' + again +
      "</div>";
  }

  function isRef(v) { return /^YB[A-Z0-9]{8,}$/.test(v); }

  function revealLast4() {
    if (!last4Wrap) return;
    last4Wrap.hidden = !isRef(codeIn.value.trim().toUpperCase());
  }

  codeIn.addEventListener("input", revealLast4);
  last4In.addEventListener("input", function () {
    last4In.value = last4In.value.replace(/\D/g, "").slice(0, 4);
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var code = codeIn.value.trim().toUpperCase();
    var ref = isRef(code);
    var last4 = ref && last4In ? last4In.value.replace(/\D/g, "").slice(-4) : "";

    if (ref) {
      if (last4.length !== 4) {
        fail("Add the last 4 digits of the number the data goes to.");
        if (last4In) last4In.focus();
        return;
      }
    } else if (!/^PD-[A-F0-9]{10}$/.test(code)) {
      fail("Enter your tracking code (PD-XXXXXXXXXX). If you have an order reference that starts YB instead, add the last 4 digits of the number below.");
      codeIn.focus();
      return;
    }

    go.disabled = true;
    go.textContent = "CHECKING...";
    report.innerHTML = '<p class="dim">Checking...</p>';

    fetch("/api/order/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, phone: last4 })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          return { ok: r.ok, body: j };
        });
      })
      .then(function (res) {
        if (res.ok && res.body && res.body.id) { show(res.body); return; }
        if (res.ok && res.body && res.body.needsLast4) {
          last4Wrap.hidden = false;
          fail(res.body.error || "Add the last 4 digits of the number.");
          if (last4In) last4In.focus();
          return;
        }
        report.innerHTML = "";
        fail((res.body && res.body.error) || "We could not find that order. Check the code and try again.");
      })
      .catch(function () {
        report.innerHTML = "";
        fail("We could not reach the shop just now. Please try again in a moment, or message us on WhatsApp.");
      })
      .then(function () {
        go.disabled = false;
        go.textContent = "CHECK STATUS";
      });
  });

  /* Arriving from the storefront modal pre-fills the code. */
  try {
    var q = new URLSearchParams(location.search).get("code");
    if (q) { codeIn.value = q.toUpperCase(); revealLast4(); }
  } catch (e) { /* older browser: the form still works, just no prefill */ }

  /* A code typed on the storefront's own track modal can hand off here, so a
     guest who closes the shop page still has somewhere to go. */
  window.addEventListener("pageshow", function () {
    try {
      var pending = sessionStorage.getItem("pdh_track_prefill");
      if (pending) {
        codeIn.value = pending.toUpperCase();
        sessionStorage.removeItem("pdh_track_prefill");
        revealLast4();
      }
    } catch (e) { /* storage blocked: harmless */ }
  });
})();