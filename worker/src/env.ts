export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  SITE_NAME: string;
  SITE_URL: string;
}
