import { Env } from "./env";

const SESSION_COOKIE = "kauk_sid";
const SESSION_DAYS = 7;

export type Admin = { email: string; role: "master" | "committee" };

const b64decode = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64encode = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};

// Password hash format: pbkdf2$<iter>$<saltB64>$<hashB64>
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  const salt = b64decode(parts[2]);
  const expected = b64decode(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    key,
    expected.length * 8
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function randomId(bytes = 32) {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  return b64encode(u).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c] as string));
}

export async function createSession(env: Env, email: string): Promise<string> {
  const sid = randomId(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, admin_email, expires_at) VALUES (?, ?, ?)")
    .bind(sid, email, expires).run();
  await env.DB.prepare("UPDATE admins SET last_login_at = datetime('now') WHERE email = ?").bind(email).run();
  return sid;
}

export function sessionCookie(sid: string): string {
  const maxAge = SESSION_DAYS * 86400;
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function currentAdmin(req: Request, env: Env): Promise<Admin | null> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT a.email AS email, a.role AS role
       FROM sessions s JOIN admins a ON a.email = s.admin_email
      WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sid).first<Admin>();
  return row ?? null;
}

export async function destroySession(req: Request, env: Env): Promise<void> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
}

export async function pruneExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}
