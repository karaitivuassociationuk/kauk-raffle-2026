(function () {
  "use strict";
  const TOTAL = 500;
  const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  let PRICE = 10;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(3, "0");
  const selected = new Set();
  let statusMap = {}; // "001" -> "pending"|"confirmed"

  // ---- toast ----
  let toastT;
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!isErr);
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 3200);
  }

  // ---- API ----
  async function api(path, opts) {
    const r = await fetch(path, { credentials: "same-origin", ...opts });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  // ---- grid ----
  const gridEl = $("grid");
  function buildGrid() {
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= TOTAL; i++) {
      const num = pad(i);
      const b = document.createElement("button");
      b.className = "cell";
      b.textContent = num;
      b.dataset.num = num;
      b.addEventListener("click", () => toggleCell(num));
      frag.appendChild(b);
    }
    gridEl.appendChild(frag);
  }

  function paintGrid(stats) {
    for (const b of gridEl.children) {
      const num = b.dataset.num;
      const st = statusMap[num];
      b.className = "cell";
      b.disabled = false;
      if (st === "confirmed") { b.classList.add("confirmed"); b.disabled = true; }
      else if (st === "pending") { b.classList.add("pending"); b.disabled = true; }
      else if (selected.has(num)) { b.classList.add("selected"); }
    }
    if (stats) {
      const total = stats.available + stats.pending + stats.confirmed;
      const pct = (n) => {
        if (!total || !n) return "0%";
        const p = (n / total) * 100;
        return p < 1 ? p.toFixed(1) + "%" : Math.round(p) + "%";
      };
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set("stat-av", stats.available);
      set("lcAvailable", stats.available);
      set("lcPending", stats.pending);
      set("lcSold", stats.confirmed);
      set("lcAvPct", pct(stats.available) + " open");
      set("lcPePct", stats.pending ? pct(stats.pending) + " pending" : " ");
      set("lcSoPct", stats.confirmed ? pct(stats.confirmed) + " sold" : " ");
    }
  }

  function toggleCell(num) {
    const st = statusMap[num];
    if (st === "pending" || st === "confirmed") return;
    if (selected.has(num)) selected.delete(num); else selected.add(num);
    paintGrid();
    updateSelbar();
  }

  function updateSelbar() {
    const n = selected.size;
    $("selCount").textContent = n;
    $("selTotal").textContent = "£" + (n * PRICE);
    $("buyBtn").disabled = n === 0;
    $("selbar").classList.toggle("show", n > 0);
  }

  async function refreshBoard() {
    try {
      const data = await api("/api/board");
      statusMap = data.tickets;
      // Drop selections that just got taken (only if pending or confirmed)
      [...selected].forEach((n) => {
        const s = statusMap[n];
        if (s === "pending" || s === "confirmed") selected.delete(n);
      });
      paintGrid(data.stats);
      updateSelbar();
    } catch (e) { console.warn(e); }
  }

  async function loadSite() {
    try {
      const s = await api("/api/site");
      if (s.ticket_price_gbp) { PRICE = s.ticket_price_gbp; $("priceAmt").textContent = "£" + PRICE; }
      if (s.draw_date) $("drawDate").textContent = s.draw_date;
      if (s.draw_venue) {
        const parts = s.draw_venue.split(",");
        $("drawVenueLine1").textContent = parts[0].trim();
        $("drawVenueLine2").textContent = parts.slice(1).join(",").trim() || "United Kingdom";
      }
    } catch (e) { console.warn(e); }
  }

  // ---- buy modal ----
  function openBuy() {
    if (selected.size === 0) return;
    const chips = $("modalChips");
    chips.innerHTML = "";
    [...selected].sort().forEach((n) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = n;
      chips.appendChild(c);
    });
    $("formErr").style.display = "none";
    $("buyModal").classList.add("show");
  }

  function closeBuy() { $("buyModal").classList.remove("show"); }

  async function confirmBuy() {
    const err = $("formErr");
    const name = $("fName").value.trim();
    const phone = $("fPhone").value.trim();
    const email = $("fEmail").value.trim();
    const postcode = $("fPostcode").value.trim();
    const channel = $("fChannel").value;
    const uk = $("fUK").checked;

    function showErr(m) { err.textContent = m; err.style.display = "block"; }
    if (!name || !phone || !email || !postcode) return showErr("Please fill in every field.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return showErr("That email doesn't look right.");
    if (!UK_POSTCODE.test(postcode)) return showErr("Please enter a valid UK postcode (e.g. OX1 2JD).");
    if (!uk) return showErr("This raffle is for UK residents only — please tick the box to confirm.");

    const numbers = [...selected].map(n => parseInt(n, 10));
    const btn = $("confirmBuy");
    btn.disabled = true; btn.textContent = "Processing…";
    try {
      const data = await api("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, email, postcode, channel, uk_resident: uk, numbers })
      });
      // success — clear form, refresh board, show success modal
      selected.clear();
      $("fName").value = ""; $("fPhone").value = ""; $("fEmail").value = "";
      $("fPostcode").value = ""; $("fUK").checked = false;
      closeBuy();
      await refreshBoard();
      showSuccess(data);
    } catch (e) {
      showErr(e.message);
      // If a clash, refresh board so the now-taken numbers go red
      if (/just taken/i.test(e.message)) refreshBoard();
    } finally {
      btn.disabled = false; btn.textContent = "Confirm purchase";
    }
  }

  function showSuccess(data) {
    const p = data.purchase;
    const info = data.payment_info || {};
    const chips = $("confChips");
    chips.innerHTML = "";
    p.numbers.forEach((n) => {
      const c = document.createElement("span"); c.className = "chip"; c.textContent = n;
      chips.appendChild(c);
    });
    $("confAmount").textContent = "£" + (p.amount_pence / 100).toFixed(2).replace(/\.00$/, "");
    $("confRef").textContent = p.ref;
    $("bankName").textContent = info.bank_account_name || "—";
    $("bankSort").textContent = info.bank_sort_code || "—";
    $("bankNo").textContent = info.bank_account_no || "—";

    if (p.channel === "cash") $("bankBox").style.display = "none";
    else $("bankBox").style.display = "block";

    const links = [];
    const wa = (num) => num ? `<a href="https://wa.me/${num.replace(/[^\d]/g, "")}?text=${encodeURIComponent("KAUK Raffle 2026 — confirming payment for reference " + p.ref)}" target="_blank" rel="noopener">WhatsApp ${num}</a>` : "";
    if (info.contact_whatsapp_1) links.push(wa(info.contact_whatsapp_1));
    if (info.contact_whatsapp_2) links.push(wa(info.contact_whatsapp_2));
    if (info.contact_email) links.push(`<a href="mailto:${info.contact_email}?subject=${encodeURIComponent("KAUK Raffle payment " + p.ref)}">Email ${info.contact_email}</a>`);
    $("contactLinks").innerHTML = links.join("<br/>");

    $("successModal").classList.add("show");
  }

  // ---- wire up ----
  $("buyBtn").addEventListener("click", openBuy);
  $("cancelBuy").addEventListener("click", closeBuy);
  $("confirmBuy").addEventListener("click", confirmBuy);
  $("successDone").addEventListener("click", () => $("successModal").classList.remove("show"));
  $("refreshBtn").addEventListener("click", () => { refreshBoard(); toast("Board updated"); });
  [$("buyModal"), $("successModal")].forEach((ov) => {
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("show"); });
  });

  // ---- init ----
  buildGrid();
  loadSite();
  refreshBoard();
  setInterval(refreshBoard, 15000);
})();
