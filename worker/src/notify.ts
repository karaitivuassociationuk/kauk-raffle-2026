import { Env } from "./env";

type Settings = Record<string, string>;

export async function loadSettings(env: Env): Promise<Settings> {
  const rs = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Settings = {};
  for (const r of rs.results ?? []) out[r.key] = r.value;
  return out;
}

function fmtMoney(p: number) { return "£" + (p / 100).toFixed(2).replace(/\.00$/, ""); }

export async function sendPurchaseEmail(env: Env, purchase: {
  email: string; name: string; ref: string; amount_pence: number; numbers: number[]; channel: string;
}, s: Settings) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    console.log("[email] skipped — RESEND_API_KEY/FROM_EMAIL not set");
    return;
  }
  const numList = purchase.numbers.map(n => String(n).padStart(3, "0")).join(", ");
  const wa1 = (s.contact_whatsapp_1 || "").replace(/\s+/g, "");
  const wa2 = (s.contact_whatsapp_2 || "").replace(/\s+/g, "");
  const subject = `KAUK Raffle 2026 — Purchase received (${purchase.ref})`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <h2 style="color:#b8141a">Thank you, ${escapeHtml(purchase.name)}!</h2>
      <p>We've received your raffle purchase. <b>Your numbers are NOT entered into the draw until payment is confirmed.</b></p>
      <p><b>Your numbers:</b> ${numList}<br/>
         <b>Amount:</b> ${fmtMoney(purchase.amount_pence)}<br/>
         <b>Reference:</b> <code style="background:#f4f4f4;padding:2px 6px">${purchase.ref}</code></p>
      ${purchase.channel === "bank" ? `
      <h3>Pay by bank transfer</h3>
      <p>
        <b>Account name:</b> ${escapeHtml(s.bank_account_name || "")}<br/>
        <b>Sort code:</b> ${escapeHtml(s.bank_sort_code || "")}<br/>
        <b>Account number:</b> ${escapeHtml(s.bank_account_no || "")}<br/>
        <b>Use reference:</b> ${purchase.ref}
      </p>` : `
      <h3>Pay by cash</h3>
      <p>Please arrange cash payment with the committee using one of the WhatsApp contacts below.</p>`}
      <h3>Confirm payment with the committee</h3>
      <p>After paying, please message a committee member with your reference <b>${purchase.ref}</b>:</p>
      <ul>
        ${wa1 ? `<li>WhatsApp: <a href="https://wa.me/${wa1.replace(/[^\d]/g, "")}">${escapeHtml(s.contact_whatsapp_1)}</a></li>` : ""}
        ${wa2 ? `<li>WhatsApp: <a href="https://wa.me/${wa2.replace(/[^\d]/g, "")}">${escapeHtml(s.contact_whatsapp_2)}</a></li>` : ""}
        ${s.contact_email ? `<li>Email: <a href="mailto:${escapeHtml(s.contact_email)}">${escapeHtml(s.contact_email)}</a></li>` : ""}
      </ul>
      <p style="color:#666;font-size:12px">Draw: ${escapeHtml(s.draw_date || "")} · ${escapeHtml(s.draw_venue || "")}</p>
    </div>`;
  await resendSend(env, purchase.email, subject, html);
}

export async function sendConfirmedEmail(env: Env, purchase: {
  email: string; name: string; ref: string; numbers: number[];
}, s: Settings) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;
  const numList = purchase.numbers.map(n => String(n).padStart(3, "0")).join(", ");
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <h2 style="color:#15803a">Payment confirmed ✓</h2>
      <p>Hi ${escapeHtml(purchase.name)},</p>
      <p>Your payment for KAUK Unity Coin Raffle 2026 has been verified by the committee.
      Your numbers <b>${numList}</b> are now officially entered into the draw.</p>
      <p>Reference: <code>${purchase.ref}</code></p>
      <p>Draw: ${escapeHtml(s.draw_date || "")} · ${escapeHtml(s.draw_venue || "")}</p>
      <p>Good luck!<br/>— Karaitivu Association UK</p>
    </div>`;
  await resendSend(env, purchase.email, `KAUK Raffle 2026 — Payment confirmed (${purchase.ref})`, html);
}

async function resendSend(env: Env, to: string, subject: string, html: string) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html })
    });
    if (!r.ok) console.warn("[resend] failed", r.status, await r.text());
  } catch (e) {
    console.warn("[resend] error", e);
  }
}

// WhatsApp Cloud API — sends a plain text message. Use approved template once Meta verification is done.
export async function sendWhatsApp(env: Env, toE164: string, body: string) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) return;
  const to = toE164.replace(/[^\d]/g, "");
  if (!to) return;
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
    });
    if (!r.ok) console.warn("[whatsapp] failed", r.status, await r.text());
  } catch (e) {
    console.warn("[whatsapp] error", e);
  }
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
