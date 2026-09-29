const $ = (s) => document.querySelector(s);
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmt(n){return Number(n).toLocaleString("en-GH",{minimumFractionDigits:2,maximumFractionDigits:2})}
function humanSize(mb){ const v=Number(mb); if(!v) return ""; return v>=1024 ? `${(v/1024).toFixed(v%1024?1:0)}GB` : `${v}MB`; }
(async function(){
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const area = $("#productDetailArea");
  if(!id){ area.innerHTML = `<p>Bundle not found. <a href="/">Back to shop</a></p>`; return; }
  try{
    const r = await fetch("/api/products"); const data = await r.json();
    const p = (data.products||[]).find(x=>String(x.id)===String(id));
    if(!p){ area.innerHTML = `<p>Bundle not found.</p>`; return; }
    const cfg = await fetch("/api/config").then(r=>r.json());
    const mp = p.memberPrice||p.sell; const gp = p.guestPrice||p.sell;
    document.title = `${humanSize(p.sizeMb)} ${p.network} | POLYMATH DATA HUB`;
    area.innerHTML = `
      <div class="acc-card">
        <span class="net-badge" style="background:${cfg.networks.find(n=>n.name===p.network)?.color||"#555"};color:#fff">${esc(p.network)}</span>
        <h1 style="margin:12px 0 6px">${esc(humanSize(p.sizeMb))} Bundle</h1>
        <p class="dim">${esc(p.name)}</p>
        <div style="margin:18px 0">
          <div style="font-size:28px;font-weight:800;color:#15803d">${esc(cfg.currency)} ${esc(fmt(mp))} <small style="font-size:12px">Member price</small></div>
          <div style="font-size:14px;color:#64748b;text-decoration:line-through">Guest ${esc(cfg.currency)} ${esc(fmt(gp))}</div>
        </div>
        <div class="pay-actions">
          <a class="btn btn-primary btn-block" href="/?plan=${esc(p.id)}">Buy now</a>
          <a class="btn btn-ghost btn-block" href="/">Back to shop</a>
        </div>
        <p class="dim" style="margin-top:12px">Automated delivery · <a href="#" onclick="navigator.share?navigator.share({title:document.title,url:location.href}):window.open('https://wa.me/?text='+encodeURIComponent(location.href),'_blank');return false">Share on WhatsApp</a></p>
      </div>`;
    $("#year").textContent = new Date().getFullYear();
  }catch(e){ area.innerHTML = `<p class="inp-err">${esc(e.message)}</p>`; }
})();
