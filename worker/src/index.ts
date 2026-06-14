import { Env } from "./env";
import {
  currentAdmin, createSession, sessionCookie, clearSessionCookie,
  verifyPassword, destroySession, pruneExpiredSessions
} from "./auth";
import { loadSettings, sendPurchaseEmail, sendConfirmedEmail, sendWhatsApp } from "./notify";

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) }
  });
const bad = (msg: string, status = 400) => json({ error: msg }, { status });

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const EMAIL = /^\S+@\S+\.\S+$/;

function genRef(): string {
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KAUK-${r}${Date.now() % 1000}`;
}

function pad3(n: number) { return String(n).padStart(3, "0"); }

async function audit(env: Env, admin: string | null, action: string, target: string | null, detail: string | null) {
  await env.DB.prepare("INSERT INTO audit_log (admin_email, action, target, detail) VALUES (?, ?, ?, ?)")
    .bind(admin, action, target, detail).run();
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    try {
      // -------- Public --------
      if (path === "/api/board" && req.method === "GET") return board(env);
      if (path === "/api/site" && req.method === "GET") return site(env);
      if (path === "/api/purchase" && req.method === "POST") return purchase(req, env, ctx);

      // -------- Admin auth --------
      if (path === "/api/admin/login" && req.method === "POST") return adminLogin(req, env);
      if (path === "/api/admin/logout" && req.method === "POST") return adminLogout(req, env);
      if (path === "/api/admin/me" && req.method === "GET") return adminMe(req, env);

      // -------- Admin-only --------
      const me = await currentAdmin(req, env);
      if (!me) return bad("unauthorized", 401);

      if (path === "/api/admin/purchases" && req.method === "GET") return adminPurchases(env);
      if (path === "/api/admin/confirm" && req.method === "POST") return adminConfirm(req, env, ctx, me.email);
      if (path === "/api/admin/release" && req.method === "POST") return adminRelease(req, env, me.email);
      if (path === "/api/admin/delete" && req.method === "POST") return adminDeletePurchase(req, env, me.email);
      if (path === "/api/admin/settings" && req.method === "GET") return adminGetSettings(env);
      if (path === "/api/admin/settings" && req.method === "POST") return adminSetSettings(req, env, me.email);
      if (path === "/api/admin/audit" && req.method === "GET") return adminAudit(env);
      if (path === "/api/admin/export" && req.method === "GET") return adminExport(env);

      // Master-only
      if (me.role !== "master") return bad("forbidden — master only", 403);
      if (path === "/api/admin/users" && req.method === "GET") return adminListUsers(env);
      if (path === "/api/admin/users" && req.method === "POST") return adminCreateUser(req, env, me.email);
      if (path === "/api/admin/users" && req.method === "DELETE") return adminDeleteUser(req, env, me.email);

      return bad("not found", 404);
    } catch (e: any) {
      console.error("handler error", e);
      return bad(e?.message || "server error", 500);
    }
  },

  async scheduled(_e: ScheduledController, env: Env) {
    await pruneExpiredSessions(env);
  }
};

// ========== handlers ==========

async function site(env: Env) {
  const s = await loadSettings(env);
  // Only expose public-facing settings to the buyer page
  return json({
    site_name: env.SITE_NAME,
    draw_date: s.draw_date,
    draw_venue: s.draw_venue,
    ticket_price_gbp: parseInt(s.ticket_price_gbp || "10", 10),
    bank_account_name: s.bank_account_name,
    bank_sort_code: s.bank_sort_code,
    bank_account_no: s.bank_account_no,
    contact_whatsapp_1: s.contact_whatsapp_1,
    contact_whatsapp_2: s.contact_whatsapp_2,
    contact_email: s.contact_email
  });
}

async function board(env: Env) {
  const rs = await env.DB.prepare("SELECT number, status FROM tickets").all<{ number: number; status: string }>();
  const tickets: Record<string, string> = {};
  let av = 0, pe = 0, co = 0;
  for (const r of rs.results ?? []) {
    tickets[pad3(r.number)] = r.status;
    if (r.status === "available") av++;
    else if (r.status === "pending") pe++;
    else co++;
  }
  return json({ tickets, stats: { available: av, pending: pe, confirmed: co } });
}

async function purchase(req: Request, env: Env, ctx: ExecutionContext) {
  const body = await req.json().catch(() => null) as any;
  if (!body) return bad("invalid body");
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const postcode = String(body.postcode || "").trim().toUpperCase();
  const channel = body.channel === "cash" ? "cash" : "bank";
  const ukResident = body.uk_resident === true;
  const numbers = Array.isArray(body.numbers) ? [...new Set(body.numbers)].map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 500) : [];

  if (!name || !phone || !email || !postcode) return bad("Please fill in all fields.");
  if (!EMAIL.test(email)) return bad("That email doesn't look valid.");
  if (!UK_POSTCODE.test(postcode)) return bad("Please enter a valid UK postcode (e.g. OX1 2JD).");
  if (!ukResident) return bad("The raffle is only open to UK residents. Please tick the confirmation.");
  if (numbers.length === 0) return bad("Pick at least one number.");

  const settings = await loadSettings(env);
  const price = parseInt(settings.ticket_price_gbp || "10", 10);
  const amount_pence = numbers.length * price * 100;
  const id = crypto.randomUUID();
  const ref = genRef();

  // Atomic claim: try to flip each requested ticket from 'available' -> 'pending' linked to this purchase.
  // If any flip fails, roll back. D1 batch executes in a single transaction.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO purchases (id, ref, name, phone, email, postcode, channel, amount_pence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(id, ref, name, phone, email, postcode, channel, amount_pence),
    ...numbers.map(n => env.DB.prepare(
      `UPDATE tickets SET status='pending', purchase_id=?, updated_at=datetime('now')
        WHERE number=? AND status='available'`
    ).bind(id, n)),
    ...numbers.map(n => env.DB.prepare(
      `INSERT INTO purchase_tickets (purchase_id, ticket_no) VALUES (?, ?)`
    ).bind(id, n))
  ];
  const results = await env.DB.batch(stmts);

  // Verify every UPDATE on tickets actually changed a row (status was available)
  const ticketUpdates = results.slice(1, 1 + numbers.length);
  const taken: number[] = [];
  ticketUpdates.forEach((r, i) => {
    const changes = (r.meta as any)?.changes ?? 0;
    if (changes !== 1) taken.push(numbers[i]);
  });

  if (taken.length) {
    // Roll back: delete the purchase + release any we did manage to flip
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE tickets SET status='available', purchase_id=NULL, updated_at=datetime('now')
          WHERE purchase_id=?`
      ).bind(id),
      env.DB.prepare(`DELETE FROM purchase_tickets WHERE purchase_id=?`).bind(id),
      env.DB.prepare(`DELETE FROM purchases WHERE id=?`).bind(id)
    ]);
    return bad(`Sorry — number${taken.length > 1 ? "s" : ""} ${taken.sort((a, b) => a - b).map(pad3).join(", ")} ${taken.length > 1 ? "were" : "was"} just taken. Please pick again.`, 409);
  }

  // Fire notifications without blocking the response
  ctx.waitUntil((async () => {
    try {
      await sendPurchaseEmail(env, { email, name, ref, amount_pence, numbers, channel }, settings);
      const wa = (phone || "").replace(/\s+/g, "");
      if (wa) {
        await sendWhatsApp(env, wa,
          `KAUK Raffle 2026: Thanks ${name}! Your numbers ${numbers.map(pad3).join(", ")} are held with reference ${ref}. ` +
          `Pay £${(amount_pence / 100).toFixed(2).replace(/\.00$/, "")} by bank to ${settings.bank_account_name} ${settings.bank_sort_code} ${settings.bank_account_no} (use ref ${ref}), ` +
          `then message us back to confirm. Numbers are entered into the draw once payment is verified.`);
      }
    } catch (e) { console.warn("notify error", e); }
  })());

  await audit(env, null, "purchase.created", id, JSON.stringify({ ref, numbers, channel, amount_pence }));

  return json({
    ok: true,
    purchase: { id, ref, numbers: numbers.map(pad3), amount_pence, channel },
    payment_info: {
      bank_account_name: settings.bank_account_name,
      bank_sort_code: settings.bank_sort_code,
      bank_account_no: settings.bank_account_no,
      contact_whatsapp_1: settings.contact_whatsapp_1,
      contact_whatsapp_2: settings.contact_whatsapp_2,
      contact_email: settings.contact_email
    }
  });
}

// ---------- admin ----------

async function adminLogin(req: Request, env: Env) {
  const body = await req.json().catch(() => null) as any;
  if (!body) return bad("invalid body");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return bad("Enter email and password.");
  const row = await env.DB.prepare("SELECT email, password_hash, role FROM admins WHERE lower(email) = ?")
    .bind(email).first<{ email: string; password_hash: string; role: string }>();
  if (!row) return bad("Incorrect email or password.", 401);
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return bad("Incorrect email or password.", 401);
  const sid = await createSession(env, row.email);
  await audit(env, row.email, "admin.login", null, null);
  return json({ ok: true, admin: { email: row.email, role: row.role } }, {
    headers: { "Set-Cookie": sessionCookie(sid) }
  });
}

async function adminLogout(req: Request, env: Env) {
  await destroySession(req, env);
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}

async function adminMe(req: Request, env: Env) {
  const me = await currentAdmin(req, env);
  if (!me) return json({ admin: null });
  return json({ admin: me });
}

async function adminPurchases(env: Env) {
  const rs = await env.DB.prepare(
    `SELECT p.id, p.ref, p.name, p.phone, p.email, p.postcode, p.channel, p.amount_pence,
            p.status, p.created_at, p.confirmed_at, p.confirmed_by, p.released_at, p.released_by, p.notes,
            (SELECT group_concat(ticket_no) FROM purchase_tickets pt WHERE pt.purchase_id = p.id) AS numbers
       FROM purchases p
      ORDER BY p.created_at DESC`
  ).all();
  const list = (rs.results ?? []).map((r: any) => ({
    ...r,
    numbers: r.numbers ? r.numbers.split(",").map((s: string) => parseInt(s, 10)).sort((a: number, b: number) => a - b) : []
  }));
  return json({ purchases: list });
}

async function adminConfirm(req: Request, env: Env, ctx: ExecutionContext, who: string) {
  const body = await req.json().catch(() => null) as any;
  const id = String(body?.id || "");
  if (!id) return bad("missing id");
  const row = await env.DB.prepare(
    `SELECT id, ref, name, email, status FROM purchases WHERE id = ?`
  ).bind(id).first<{ id: string; ref: string; name: string; email: string; status: string }>();
  if (!row) return bad("not found", 404);
  if (row.status === "confirmed") return json({ ok: true, already: true });
  if (row.status !== "pending") return bad("can only confirm pending purchases");

  await env.DB.batch([
    env.DB.prepare(`UPDATE purchases SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`).bind(who, id),
    env.DB.prepare(`UPDATE tickets SET status='confirmed', updated_at=datetime('now') WHERE purchase_id=?`).bind(id)
  ]);
  await audit(env, who, "purchase.confirmed", id, null);

  ctx.waitUntil((async () => {
    const numsRs = await env.DB.prepare(`SELECT ticket_no FROM purchase_tickets WHERE purchase_id=? ORDER BY ticket_no`).bind(id).all<{ ticket_no: number }>();
    const numbers = (numsRs.results ?? []).map(x => x.ticket_no);
    const s = await loadSettings(env);
    try { await sendConfirmedEmail(env, { email: row.email, name: row.name, ref: row.ref, numbers }, s); } catch (e) { console.warn(e); }
  })());

  return json({ ok: true });
}

async function adminRelease(req: Request, env: Env, who: string) {
  const body = await req.json().catch(() => null) as any;
  const id = String(body?.id || "");
  const reason = String(body?.reason || "").slice(0, 500);
  if (!id) return bad("missing id");
  const row = await env.DB.prepare(`SELECT id, status FROM purchases WHERE id=?`).bind(id).first<{ id: string; status: string }>();
  if (!row) return bad("not found", 404);
  if (row.status === "released") return json({ ok: true, already: true });

  await env.DB.batch([
    env.DB.prepare(`UPDATE tickets SET status='available', purchase_id=NULL, updated_at=datetime('now') WHERE purchase_id=?`).bind(id),
    env.DB.prepare(`UPDATE purchases SET status='released', released_at=datetime('now'), released_by=?, notes=COALESCE(notes,'') || CASE WHEN ?='' THEN '' ELSE char(10) || 'Released: ' || ? END WHERE id=?`).bind(who, reason, reason, id)
  ]);
  await audit(env, who, "purchase.released", id, reason || null);
  return json({ ok: true });
}

async function adminDeletePurchase(req: Request, env: Env, who: string) {
  const body = await req.json().catch(() => null) as any;
  const id = String(body?.id || "");
  const reason = String(body?.reason || "").slice(0, 500);
  if (!id) return bad("missing id");
  const row = await env.DB.prepare(`SELECT id, ref, status FROM purchases WHERE id=?`).bind(id).first<{ id: string; ref: string; status: string }>();
  if (!row) return bad("not found", 404);

  // Free any held tickets back to available, then cascade-delete the purchase
  await env.DB.batch([
    env.DB.prepare(`UPDATE tickets SET status='available', purchase_id=NULL, updated_at=datetime('now') WHERE purchase_id=?`).bind(id),
    env.DB.prepare(`DELETE FROM purchase_tickets WHERE purchase_id=?`).bind(id),
    env.DB.prepare(`DELETE FROM purchases WHERE id=?`).bind(id)
  ]);
  await audit(env, who, "purchase.deleted", id, JSON.stringify({ ref: row.ref, prev_status: row.status, reason }));
  return json({ ok: true });
}

async function adminGetSettings(env: Env) {
  const s = await loadSettings(env);
  return json({ settings: s });
}

async function adminSetSettings(req: Request, env: Env, who: string) {
  const body = await req.json().catch(() => null) as any;
  if (!body || typeof body !== "object") return bad("invalid body");
  const allowed = new Set([
    "bank_account_name", "bank_sort_code", "bank_account_no",
    "contact_whatsapp_1", "contact_whatsapp_2", "contact_email",
    "draw_date", "draw_venue", "ticket_price_gbp"
  ]);
  const updates: [string, string][] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) updates.push([k, String(v ?? "")]);
  }
  if (!updates.length) return bad("no valid fields");
  await env.DB.batch(updates.map(([k, v]) =>
    env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v)
  ));
  await audit(env, who, "settings.updated", null, JSON.stringify(Object.fromEntries(updates)));
  return json({ ok: true });
}

async function adminAudit(env: Env) {
  const rs = await env.DB.prepare(`SELECT id, at, admin_email, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 200`).all();
  return json({ entries: rs.results ?? [] });
}

async function adminExport(env: Env) {
  const rs = await env.DB.prepare(
    `SELECT p.ref, p.status, p.name, p.phone, p.email, p.postcode, p.channel, p.amount_pence,
            p.created_at, p.confirmed_at, p.confirmed_by,
            (SELECT group_concat(ticket_no, ' ') FROM purchase_tickets pt WHERE pt.purchase_id = p.id) AS numbers
       FROM purchases p ORDER BY p.created_at DESC`
  ).all();
  const rows = [
    ["Reference", "Status", "Name", "Phone", "Email", "Postcode", "Channel", "Amount(£)", "Numbers", "Created", "Confirmed at", "Confirmed by"]
  ];
  for (const r of (rs.results ?? []) as any[]) {
    rows.push([
      r.ref, r.status, r.name, r.phone, r.email, r.postcode, r.channel,
      (r.amount_pence / 100).toFixed(2),
      r.numbers || "", r.created_at || "", r.confirmed_at || "", r.confirmed_by || ""
    ]);
  }
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kauk-raffle-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}

// ---------- master-only ----------

async function adminListUsers(env: Env) {
  const rs = await env.DB.prepare("SELECT email, role, created_at, last_login_at FROM admins ORDER BY role, email").all();
  return json({ users: rs.results ?? [] });
}

async function adminCreateUser(req: Request, env: Env, who: string) {
  const body = await req.json().catch(() => null) as any;
  const email = String(body?.email || "").trim().toLowerCase();
  const password_hash = String(body?.password_hash || "");
  const role = body?.role === "master" ? "master" : "committee";
  if (!email || !password_hash) return bad("email and password_hash required");
  if (!password_hash.startsWith("pbkdf2$")) return bad("password_hash must be generated with `npm run hash-password`");
  await env.DB.prepare(
    `INSERT INTO admins (email, password_hash, role) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`
  ).bind(email, password_hash, role).run();
  await audit(env, who, "admin.user.upserted", email, JSON.stringify({ role }));
  return json({ ok: true });
}

async function adminDeleteUser(req: Request, env: Env, who: string) {
  const body = await req.json().catch(() => null) as any;
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) return bad("email required");
  if (email === who) return bad("you can't delete your own account");
  await env.DB.prepare("DELETE FROM admins WHERE email = ?").bind(email).run();
  await audit(env, who, "admin.user.deleted", email, null);
  return json({ ok: true });
}
