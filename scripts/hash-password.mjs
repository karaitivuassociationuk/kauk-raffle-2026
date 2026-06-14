// Hash an admin password for seeding into D1.
// Usage:  npm run hash-password -- 'your password here'
//
// Uses PBKDF2-SHA256 with 200k iterations + random salt. Format: pbkdf2$200000$<saltB64>$<hashB64>
// This matches the verifier in worker/src/auth.ts.

import { webcrypto as crypto } from "node:crypto";

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: npm run hash-password -- 'your password'");
  process.exit(1);
}

const ITER = 100_000; // Cloudflare Workers Web Crypto caps PBKDF2 iterations at 100k
const salt = crypto.getRandomValues(new Uint8Array(16));
const enc = new TextEncoder();

const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER },
  key,
  256
);

const b64 = (buf) => Buffer.from(buf).toString("base64");
console.log(`pbkdf2$${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
