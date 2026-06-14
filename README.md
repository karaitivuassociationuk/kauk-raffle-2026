# KAUK Unity Coin Raffle 2026

Online raffle site + organiser dashboard for the **Karaitivu Association UK** Unity Coin Raffle 2026.

- 500 tickets at £10 each
- Payment by bank transfer or cash (no card payments)
- UK residents only
- Admin dashboard to mark payments as confirmed or release numbers back to the pool
- Email notifications on purchase + confirmation (WhatsApp optional once Meta verification is approved)

## Tech

- **Frontend**: static HTML/CSS/JS in `public/`
- **Backend**: Cloudflare Worker in `worker/src/` (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Email**: Resend
- **WhatsApp** (optional): Meta WhatsApp Cloud API

Hosted on Cloudflare Pages — frontend and API run from the same worker.

---

## One-time setup

### 1. Install prerequisites

You need Node.js 20+ and a Cloudflare account.

```powershell
node -v        # should be 20 or higher
npm install
```

### 2. Sign in to Cloudflare

This project deploys to your `gjtglobe@gmail.com` Cloudflare account.

```powershell
npx wrangler login
```

A browser window opens — sign in with `gjtglobe@gmail.com` and click **Allow**.

### 3. Create the D1 database

```powershell
npx wrangler d1 create kauk_raffle
```

The command prints a block like:

```toml
[[d1_databases]]
binding = "DB"
database_name = "kauk_raffle"
database_id = "abcd1234-..."
```

Copy the `database_id` value into `wrangler.toml` (replace `REPLACE_AFTER_D1_CREATE`).

### 4. Apply the schema

```powershell
npm run db:schema
```

This creates all tables and seeds 500 tickets.

### 5. Create the two admin accounts

Generate password hashes — pick strong passwords:

```powershell
npm run hash-password -- 'master-password-here'
# copy the pbkdf2$... output

npm run hash-password -- 'committee-password-here'
# copy the pbkdf2$... output
```

Copy `worker/seed-admins.sql.example` to `worker/seed-admins.sql`, paste the hashes in, then:

```powershell
npm run db:seed-admins
```

Delete `worker/seed-admins.sql` afterwards (it's gitignored, but don't tempt fate).

> Default seeded emails: `gopinaath.ruthran@gmail.com` (master) and `karaitivuassociationuk@gmail.com` (committee).

### 6. Set worker secrets

```powershell
# Random secret used to sign session cookies (any 32+ char random string)
npx wrangler secret put SESSION_SECRET

# Resend (sign up at https://resend.com — free tier)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FROM_EMAIL    # e.g. raffle@karaitivuassociation.org.uk (must be verified in Resend)
```

WhatsApp is optional — leave the secrets unset and the site will still work, just without WhatsApp messages (the buyer gets `wa.me` click-to-chat links in the email instead). To enable later:

```powershell
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_ID
```

### 7. Deploy

```powershell
npm run deploy
```

This deploys both the Worker and the static frontend together. Wrangler prints the live URL — something like `https://kauk-raffle-2026.<account>.workers.dev`.

To attach a custom domain (e.g. `raffle.karaitivuassociation.org.uk`), go to the Cloudflare dashboard → your Worker → **Settings → Triggers → Custom Domains**.

---

## Day-to-day operations

### As an organiser

1. Go to `/admin.html` on the live site.
2. Sign in with your email + password.
3. **Purchases** tab — see all buyers. When someone confirms payment via WhatsApp/email:
   - Click **Mark paid** → their numbers go red (confirmed) and they get a confirmation email.
   - If a buyer wants to cancel: click **Release** → numbers go back to the pool.
4. **Settings** tab — edit bank details, committee contacts, draw date/venue, ticket price.
5. **Audit log** — every admin action is logged with timestamp + who.
6. **Export CSV** — for the draw day, download all confirmed buyers.

### As master (only `gopinaath.ruthran@gmail.com`)

Same as above, plus the **Admin users** tab to add or remove organisers.

To add a new admin:

1. On your laptop: `npm run hash-password -- 'their password'`
2. Copy the `pbkdf2$…` output.
3. In the Admin users tab: enter their email, choose role, paste the hash, click Save.
4. Tell them the password through a secure channel (not the same channel you sent the email on).

---

## Local development

```powershell
# Copy .dev.vars.example to .dev.vars and fill in values for local testing
copy .dev.vars.example .dev.vars

# Apply schema to local D1
npm run db:schema:local

# Run locally — opens at http://localhost:8787
npm run dev
```

---

## Project layout

```
kauk-raffle-2026/
├── public/                # Static frontend
│   ├── index.html         # Buyer site
│   ├── admin.html         # Organiser dashboard
│   ├── app.js / admin.js
│   ├── style.css
│   └── assets/logo.svg    # Placeholder — replace with real KAUK logo
├── worker/
│   ├── src/
│   │   ├── index.ts       # API routes
│   │   ├── auth.ts        # Sessions + password verify
│   │   ├── notify.ts      # Email + WhatsApp
│   │   └── env.ts
│   ├── schema.sql         # D1 tables + 500-ticket seed
│   └── seed-admins.sql.example
├── scripts/
│   └── hash-password.mjs  # PBKDF2 hash generator
├── wrangler.toml
├── package.json
└── README.md
```

---

## Security notes

- **Admin passwords** are hashed server-side with PBKDF2-SHA256 (200k iterations). Never stored or transmitted in plaintext after the login request.
- **Session cookies** are HttpOnly, Secure, SameSite=Lax with 7-day expiry. Server-side session rows mean logout actually revokes.
- **Atomic ticket locking**: a purchase either claims every requested number or none of them. No double-selling.
- **UK postcode + residency check** happens on both client and server.
- **Audit log** records every admin action with a timestamp and who did it.

## Changing the admin password

Run the hash generator on your machine, then either:

- Re-seed via SQL: `wrangler d1 execute kauk_raffle --remote --command="UPDATE admins SET password_hash='pbkdf2$…' WHERE email='you@example.com'"`
- Or use the master account's **Admin users** tab to overwrite the existing user.

---

## License & credit

Built for Karaitivu Association United Kingdom. Not for redistribution.
