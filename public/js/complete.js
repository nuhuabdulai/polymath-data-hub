// complete.js - Handles Payment Return & Order Status Polling (fixed)
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function renderProgress(progress) {
    const target = $("#progressTrack");
    if (!target || !progress || !Array.isArray(progress.steps)) return;
    target.innerHTML = progress.steps.map((step) => `<div class="progress-step ${esc(step.state)}" role="listitem"><span class="progress-dot" aria-hidden="true">${step.state === "complete" ? "✓" : step.state === "current" ? "•" : ""}</span><span>${esc(step.label)}</span></div>`).join("");
  }
  const params = new URLSearchParams(location.search);
  // Paystack sends reference=paystackRef (also trxref), or ?ref=YB... if we passed orderId via callback
  const rawRef = (params.get("reference") || params.get("trxref") || params.get("ref") || params.get("order") || "").trim().toUpperCase();
  const orderIdFromStorage = rawRef ? sessionStorage.getItem(`paystack_order_${rawRef}`) : null;
  // Prefer YB order id if we mapped it, otherwise treat rawRef as YB id fallback
  let ybRef = orderIdFromStorage || rawRef;
  // Also support ?order=YB... directly
  if (params.get("order")) ybRef = String(params.get("order")).trim().toUpperCase();

  const refEl = $("#refHere");
  const statNote = $("#statNote");
  const statusIcon = $("#statusIcon");
  const statusTitle = $("#statusTitle");
  const phoneGroup = $("#phoneInputGroup");
  const phoneInput = $("#phoneSuffixInput");
  const verifyBtn = $("#verifyBtn");

  if (refEl && ybRef) refEl.textContent = ybRef;
  else if (refEl && rawRef) refEl.textContent = rawRef;

  fetch("/api/config").then((r) => r.json()).then((cfg) => {
    if (cfg.contact && cfg.contact.whatsapp) {
      const link = $("#waLink");
      if (link) { link.hidden = false; link.href = `https://wa.me/${cfg.contact.whatsapp}${ybRef ? `?text=${encodeURIComponent(`Hi, I just paid for data order ${ybRef}. Please confirm.`)}` : ""}`; }
    }
  }).catch(() => {});

  if (!ybRef && !rawRef) {
    if (statNote) statNote.textContent = "No order reference found in the link. Check your order history in your account.";
    if (statusTitle) statusTitle.textContent = "No reference";
    return;
  }

  let attempts = 0;
  const maxAttempts = 20;
  const pollInterval = 3000;
  let phoneSuffix = ybRef ? sessionStorage.getItem(`order_phone_${ybRef}`) : null;
  // also try rawRef mapping
  if (!phoneSuffix && rawRef) phoneSuffix = sessionStorage.getItem(`order_phone_${rawRef}`);

  function setStatus(icon, title) {
    if (statusIcon) statusIcon.textContent = icon;
    if (statusTitle) statusTitle.textContent = title;
  }

  async function pollStatus() {
    if (attempts >= maxAttempts) {
      if (statNote) statNote.innerHTML = `Verification timed out. <a href="/account" class="btn btn-light">Check account history</a> or <a href="#" onclick="document.getElementById('waLink').click();return false">WhatsApp support</a>.`;
      setStatus("⏱️", "Still processing");
      return;
    }
    attempts++;
    try {
      // ybRef is our YB... id; if we only have paystack ref, we can't use /api/order/status directly, so show help
      const idToCheck = ybRef || rawRef;
      if (!idToCheck || !phoneSuffix) {
        if (phoneGroup) phoneGroup.hidden = false;
        return;
      }
      const res = await fetch("/api/order/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: idToCheck, phone: phoneSuffix }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Status check failed");
      updateUI(data);
      if (data.status === "delivered" || data.status === "failed" || data.status === "refunded") return;
      setTimeout(pollStatus, pollInterval);
    } catch (e) {
      console.error(e);
      // If not found via YB id, maybe rawRef is paystackRef and order still pending, so retry
      setTimeout(pollStatus, pollInterval);
    }
  }

  function updateUI(data) {
    const map = {
      pending: ["⏳", "Awaiting payment confirmation"],
      pending_payment: ["💳", "Payment initiated, waiting for bank"],
      paid: ["✅", "Payment confirmed, processing"],
      processing: ["⚙️", "Delivering your data bundle…"],
      delivered: ["🎉", "Delivered successfully!"],
      failed: ["❌", "Delivery failed"],
      refunded: ["🔄", "Refunded"],
    };
     const cur = map[data.status] || ["📦", data.status];
     renderProgress(data.progress);
     setStatus(cur[0], cur[1]);
    if (refEl) refEl.textContent = data.id || ybRef;
    if (statNote) {
      if (data.status === "delivered") {
        document.body.classList.add("status-success");
        statNote.innerHTML = `Data sent to ${data.network} number ending in ${phoneSuffix || "****"}.<br><small>Order ${data.id} · ${data.planName}</small>`;
      } else if (data.status === "failed") {
        document.body.classList.add("status-error");
        statNote.textContent = "Delivery failed. Message us on WhatsApp and we'll sort it out.";
      } else {
        statNote.textContent = data.progress && data.progress.label ? data.progress.label : cur[1];
      }
    }
  }

  function start() {
    if (!phoneSuffix) {
      if (phoneGroup) phoneGroup.hidden = false;
      if (statNote) statNote.textContent = `Order ${ybRef || rawRef}. Enter the last 4 digits of the beneficiary number to check status.`;
      return;
    }
    pollStatus();
  }

  if (verifyBtn && phoneInput) {
    verifyBtn.addEventListener("click", () => {
      const v = phoneInput.value.replace(/\D/g, "").slice(0, 4);
      if (v.length !== 4) { alert("Please enter exactly 4 digits."); return; }
      phoneSuffix = v;
      if (ybRef) sessionStorage.setItem(`order_phone_${ybRef}`, v);
      if (rawRef) sessionStorage.setItem(`order_phone_${rawRef}`, v);
      phoneGroup.hidden = true;
      attempts = 0;
      pollStatus();
    });
    phoneInput.addEventListener("keydown", (e) => e.key === "Enter" && verifyBtn.click());
  }

  start();
})();
