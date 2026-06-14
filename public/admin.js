(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(3, "0");
  let me = null;
  let cachedPurchases = [];

  let toastT;
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!isErr);
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 3000);
  }

  async function api(path, opts) {
    const r = await fetch(path, { credentials: "same-origin", ...opts });
    const ct = r.headers.get("Content-Type") || "";
    const data = ct.includes("json") ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
    return data;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fmtGbp(pence) { return "£" + (pence / 100).toFixed(2).replace(/\.00$/, ""); }

  // ---- auth ----
  async function tryLogin() {
    const email = $("loginEmail").value.trim();
    const password = $("loginPass").value;
    const err = $("loginErr");
    err.style.display = "none";
    if (!email || !password) { err.textContent = "Enter email and password."; err.style.display = "block"; return; }
    try {
      const r = await api("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      me = r.admin;
      showDash();
    } catch (e) { err.textContent = e.message; err.style.display = "block"; }
  }

  async function logout() {
    try { await api("/api/admin/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    me = null;
    $("dashView").style.display = "none";
    $("loginView").style.display = "block";
    $("loginEmail").value = ""; $("loginPass").value = "";
  }

  function showDash() {
    $("loginView").style.display = "none";
    $("dashView").style.display = "block";
    $("whoEmail").textContent = me.email;
    $("whoRole").textContent = "(" + me.role + ")";
    if (me.role === "master") $("usersTab").style.display = "inline-block";
    reloadAll();
  }

  // ---- tabs ----
  function selectTab(name) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    ["purchases", "settings", "users", "audit"].forEach(n => {
      const el = $("tab-" + n);
      if (el) el.style.display = (n === name ? "block" : "none");
    });
    if (name === "settings") loadSettings();
    if (name === "users") loadUsers();
    if (name === "audit") loadAudit();
  }

  // ---- purchases ----
  async function loadPurchases() {
    const data = await api("/api/admin/purchases");
    cachedPurchases = data.purchases || [];
    renderPurchases();
    renderStats();
  }

  function renderStats() {
    let confirmedCount = 0, pendingCount = 0, confirmedPence = 0, pendingPence = 0;
    for (const p of cachedPurchases) {
      if (p.status === "confirmed") { confirmedCount += p.numbers.length; confirmedPence += p.amount_pence; }
      else if (p.status === "pending") { pendingCount += p.numbers.length; pendingPence += p.amount_pence; }
    }
    $("aConfirmed").textContent = confirmedCount;
    $("aPending").textContent = pendingCount;
    $("aAvailable").textContent = Math.max(0, 500 - confirmedCount - pendingCount);
    $("aRaised").textContent = fmtGbp(confirmedPence);
    $("aPipeline").textContent = fmtGbp(pendingPence);
  }

  function renderPurchases() {
    const body = $("purchasesBody");
    const q = $("searchBox").value.trim().toLowerCase();
    const sf = $("statusFilter").value;
    const list = cachedPurchases.filter(p => {
      if (sf && p.status !== sf) return false;
      if (!q) return true;
      const hay = [p.ref, p.name, p.phone, p.email, p.postcode, p.numbers.map(pad).join(" ")].join(" ").toLowerCase();
      return hay.includes(q);
    });
    if (list.length === 0) { body.innerHTML = '<div class="empty">No matching purchases.</div>'; return; }

    const rows = list.map(p => {
      const badge = p.status === "confirmed" ? '<span class="badge b-confirmed">Confirmed</span>'
                  : p.status === "released"  ? '<span class="badge b-released">Released</span>'
                  : '<span class="badge b-pending">Pending</span>';
      const chips = p.numbers.map(n => `<span class="chip">${pad(n)}</span>`).join("");
      let actions = "";
      if (p.status === "pending") {
        actions = `<button class="mini ok" data-act="confirm" data-id="${p.id}">Mark paid</button>
                   <button class="mini rel" data-act="release" data-id="${p.id}">Release</button>`;
      } else if (p.status === "confirmed") {
        actions = `<button class="mini rel" data-act="release" data-id="${p.id}">Release</button>`;
      }
      const wa = (p.phone || "").replace(/[^\d]/g, "");
      const waLink = wa ? `<a class="nochrome-link" href="https://wa.me/${wa}?text=${encodeURIComponent("KAUK Raffle 2026 — re: " + p.ref)}" target="_blank" rel="noopener">WhatsApp</a>` : "";
      return `<tr>
        <td>${badge}<br/><span class="refcode" style="font-size:11px">${escapeHtml(p.ref)}</span></td>
        <td><b style="color:#fff">${escapeHtml(p.name)}</b><br/>
            <span style="color:var(--ink-dim);font-size:11px">${escapeHtml(p.phone)} ${waLink ? "· " + waLink : ""}<br/>${escapeHtml(p.email)}<br/>${escapeHtml(p.postcode)} · ${escapeHtml(p.channel)}</span></td>
        <td><div class="num-chips">${chips}</div>
            <span style="color:var(--ink-dim);font-size:11px">${fmtGbp(p.amount_pence)}</span></td>
        <td style="font-size:11px;color:var(--ink-dim);white-space:nowrap;">
          ${escapeHtml(p.created_at || "")}
          ${p.confirmed_at ? `<br/>✓ ${escapeHtml(p.confirmed_at)}<br/>by ${escapeHtml(p.confirmed_by || "")}` : ""}
          ${p.released_at ? `<br/>↺ ${escapeHtml(p.released_at)}<br/>by ${escapeHtml(p.released_by || "")}` : ""}
        </td>
        <td style="white-space:nowrap;">${actions}</td>
      </tr>`;
    }).join("");

    body.innerHTML = `<table>
      <thead><tr><th>Status / Ref</th><th>Buyer</th><th>Numbers</th><th>Timestamps</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody></table>`;

    body.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", () => handleAction(btn.dataset.act, btn.dataset.id));
    });
  }

  async function handleAction(act, id) {
    try {
      if (act === "confirm") {
        if (!confirm("Mark this purchase as paid? The buyer will be emailed a confirmation.")) return;
        await api("/api/admin/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        toast("Marked as paid");
      } else if (act === "release") {
        const reason = prompt("Release these numbers back to the pool? Optional note (visible only to admins):", "");
        if (reason === null) return;
        await api("/api/admin/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, reason }) });
        toast("Released");
      }
      await loadPurchases();
    } catch (e) { toast(e.message, true); }
  }

  // ---- settings ----
  async function loadSettings() {
    try {
      const { settings } = await api("/api/admin/settings");
      ["bank_account_name","bank_sort_code","bank_account_no","contact_whatsapp_1","contact_whatsapp_2","contact_email","draw_date","draw_venue","ticket_price_gbp"]
        .forEach(k => { const el = $("set-" + k); if (el) el.value = settings[k] || ""; });
    } catch (e) { toast(e.message, true); }
  }

  async function saveSettings() {
    const body = {};
    ["bank_account_name","bank_sort_code","bank_account_no","contact_whatsapp_1","contact_whatsapp_2","contact_email","draw_date","draw_venue","ticket_price_gbp"]
      .forEach(k => { body[k] = $("set-" + k).value.trim(); });
    try {
      await api("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      toast("Settings saved");
    } catch (e) { toast(e.message, true); }
  }

  // ---- users (master only) ----
  async function loadUsers() {
    try {
      const { users } = await api("/api/admin/users");
      const body = $("usersBody");
      if (!users || !users.length) { body.innerHTML = '<div class="empty">No users.</div>'; return; }
      body.innerHTML = `<table>
        <thead><tr><th>Email</th><th>Role</th><th>Created</th><th>Last login</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td><b style="color:#fff">${escapeHtml(u.email)}</b></td>
          <td>${escapeHtml(u.role)}</td>
          <td style="font-size:11px;color:var(--ink-dim)">${escapeHtml(u.created_at || "")}</td>
          <td style="font-size:11px;color:var(--ink-dim)">${escapeHtml(u.last_login_at || "—")}</td>
          <td>${u.email === me.email ? "" : `<button class="mini del" data-del="${escapeHtml(u.email)}">Remove</button>`}</td>
        </tr>`).join("")}</tbody></table>`;
      body.querySelectorAll("button[data-del]").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove " + btn.dataset.del + "? They will lose access immediately.")) return;
          try {
            await api("/api/admin/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: btn.dataset.del }) });
            toast("User removed");
            loadUsers();
          } catch (e) { toast(e.message, true); }
        });
      });
    } catch (e) { toast(e.message, true); }
  }

  async function addUser() {
    const email = $("newUserEmail").value.trim().toLowerCase();
    const role = $("newUserRole").value;
    const password_hash = $("newUserHash").value.trim();
    if (!email || !password_hash) { toast("Enter email and password hash", true); return; }
    try {
      await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role, password_hash }) });
      $("newUserEmail").value = ""; $("newUserHash").value = "";
      toast("User saved");
      loadUsers();
    } catch (e) { toast(e.message, true); }
  }

  // ---- audit ----
  async function loadAudit() {
    try {
      const { entries } = await api("/api/admin/audit");
      const body = $("auditBody");
      if (!entries.length) { body.innerHTML = '<div class="empty">No audit events yet.</div>'; return; }
      body.innerHTML = entries.map(e => `<div class="audit-row">
        <span class="at">${escapeHtml(e.at)}</span> ·
        <span class="act">${escapeHtml(e.action)}</span> ·
        by ${escapeHtml(e.admin_email || "system")}
        ${e.target ? `· target <code>${escapeHtml(e.target)}</code>` : ""}
        ${e.detail ? `<br/><span style="color:var(--ink-dim);font-size:11px">${escapeHtml(e.detail)}</span>` : ""}
      </div>`).join("");
    } catch (e) { toast(e.message, true); }
  }

  function reloadAll() { loadPurchases(); }

  // ---- wire up ----
  $("loginBtn").addEventListener("click", tryLogin);
  $("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });
  $("logoutBtn").addEventListener("click", logout);
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => selectTab(t.dataset.tab)));
  $("searchBox").addEventListener("input", renderPurchases);
  $("statusFilter").addEventListener("change", renderPurchases);
  $("reloadBtn").addEventListener("click", reloadAll);
  $("exportBtn").addEventListener("click", () => { window.location.href = "/api/admin/export"; });
  $("saveSettings").addEventListener("click", saveSettings);
  $("addUserBtn").addEventListener("click", addUser);

  // session check on load
  (async function init() {
    try {
      const r = await api("/api/admin/me");
      if (r.admin) { me = r.admin; showDash(); }
    } catch (e) { /* not logged in */ }
  })();
})();
