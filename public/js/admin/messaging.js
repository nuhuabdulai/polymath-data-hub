/* notice board and OTP delivery.
   Split out of the single admin.js so a change to one tab cannot be confused
   with a change to another. Loaded as a classic script, so the helpers in
   core.js are shared globals rather than imports. */
async function loadMessaging() {
  const { ok, data } = await ajax("/api/admin/messaging");
  const view = $("#messagingView");
  if (!ok) { view.innerHTML = `<div class="feature"><h3>Could not load</h3><p class="dim">${esc(data.error || "unknown error")}</p></div>`; toast(data.error || "Failed to load", true); return; }
  const w = data.whatsapp || {};
  const badge = (on, label) => `<span class="badge ${on ? "delivered" : "pending"}">${on ? "OK" : "not set"}</span> ${label}`;
  view.innerHTML = `
    <div class="feature" style="max-width:700px">
      <h3>OTP delivery</h3>
      <p class="dim">Customers receive codes over WhatsApp first, then SMS. Current channel: <b>${esc(data.label || data.channel)}</b></p>
      <table class="admin-table" style="margin:14px 0">
        <tbody>
          <tr><td>WhatsApp token + phone ID</td><td>${badge(w.on, "")}</td></tr>
          <tr><td>WhatsApp template</td><td>${badge(w.template, w.template ? esc(w.template) : "free-form text (test number only)")}</td></tr>
          <tr><td>WhatsApp app secret (webhook)</td><td>${badge(w.appSecret, "")}</td></tr>
          <tr><td>WhatsApp verify token</td><td>${badge(w.verifyToken, "")}</td></tr>
          <tr><td>Graph API version</td><td>${esc(w.apiVersion || "n/a")}</td></tr>
          <tr><td>SMS fallback (Arkesel)</td><td>${badge(data.sms.arksel, "")}</td></tr>
          <tr><td>SMS fallback (Africa's Talking)</td><td>${badge(data.sms.africastalking, "")}</td></tr>
        </tbody>
      </table>
      <div class="field"><label for="testPhone">Test number (Ghana, e.g. 0244123456)</label><input id="testPhone" type="tel" inputmode="tel" maxlength="13" placeholder="0500000000" /></div>
      <div class="pay-actions"><button type="button" class="btn btn-primary" id="btnTestOtp">Send test code</button></div>
      <p class="dim" id="testOut" style="margin-top:12px"></p>
      <p class="dim" style="margin-top:18px">Register this webhook in Meta (WhatsApp → Configuration → Webhooks), subscribe to <b>messages</b>:<br><code>${esc(data.webhookUrl)}</code></p>
    </div>`;
  $("#btnTestOtp").addEventListener("click", async () => {
    const btn = $("#btnTestOtp");
    const out = $("#testOut");
    btn.disabled = true; btn.textContent = "Sending…"; out.textContent = "";
    const r = await ajax("/api/admin/test-otp", { method: "POST", body: JSON.stringify({ phone: $("#testPhone").value.trim() }) });
    btn.disabled = false; btn.textContent = "Send test code";
    if (!r.ok) { out.textContent = `Failed: ${r.data.error || "unknown error"}`; out.style.color = "#b91c1c"; return; }
    out.textContent = r.data.mockCode ? `Test mode. Code is ${r.data.mockCode} (not actually sent).` : `Sent via ${r.data.channel} to ${r.data.to}.`;
    out.style.color = "#15803d";
  });
  toast("");
}
