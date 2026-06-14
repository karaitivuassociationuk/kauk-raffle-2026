-- KAUK Raffle 2026 — D1 schema
-- Run with: wrangler d1 execute kauk_raffle --remote --file=./worker/schema.sql

PRAGMA foreign_keys = ON;

-- Tickets: 1..500. Status managed by purchase lifecycle.
CREATE TABLE IF NOT EXISTS tickets (
  number       INTEGER PRIMARY KEY CHECK (number BETWEEN 1 AND 500),
  status       TEXT NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','pending','confirmed')),
  purchase_id  TEXT REFERENCES purchases(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed 500 tickets (idempotent: INSERT OR IGNORE)
INSERT OR IGNORE INTO tickets (number)
  WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 500
  )
  SELECT n FROM seq;

CREATE TABLE IF NOT EXISTS purchases (
  id           TEXT PRIMARY KEY,
  ref          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT NOT NULL,
  postcode     TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('bank','cash')),
  amount_pence INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','released')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  confirmed_by TEXT,
  released_at  TEXT,
  released_by  TEXT,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_status  ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

-- Link table for purchase <-> ticket numbers (one purchase can have many)
CREATE TABLE IF NOT EXISTS purchase_tickets (
  purchase_id  TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  ticket_no    INTEGER NOT NULL REFERENCES tickets(number),
  PRIMARY KEY (purchase_id, ticket_no)
);

CREATE TABLE IF NOT EXISTS admins (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('master','committee')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL REFERENCES admins(email) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Editable site settings (bank, contacts, draw date, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('bank_account_name',  'KARAITIVU ASSOCIATION UK'),
  ('bank_sort_code',     '20-25-19'),
  ('bank_account_no',    '83390837'),
  ('contact_whatsapp_1', '+44 7411 412565'),
  ('contact_whatsapp_2', '+44 7903 437584'),
  ('contact_email',      'karaitivuassociationuk@gmail.com'),
  ('draw_date',          '20 June 2026'),
  ('draw_venue',         'World Tamil Historical Centre, Oxford, United Kingdom'),
  ('ticket_price_gbp',   '10');

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  admin_email TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
