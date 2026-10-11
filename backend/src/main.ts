/**
 * Environment:
 *   PORT              default 4000
 *   DATABASE_URL      PostgreSQL connection string. Unset → embedded PGlite in ./.data/pglite
 *   ALLOWED_ORIGINS   comma-separated exact frontend origins (default http://localhost:3001)
 *   NODE_ENV          "production" forces secure cookies and disables the dev credit route
 *   DEV_CREDIT        "1" enables POST /dev/deposit outside production
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openPglite, openPostgres } from "./db.js";
import type { Mailer } from "./auth.js";

const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3001").split(",").map((s) => s.trim()).filter(Boolean);

if (production && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite("./.data/pglite");

// Phase 1 has no mail provider: codes go to this server's console, never to the browser.
if (production) throw new Error("A mail provider is required before running in production");
const mailer: Mailer = {
  async sendVerificationCode(email, code) {
    console.log(`[mail] verification code for ${email}: ${code}`);
  },
};

const app = createApp(db, mailer, {
  allowedOrigins,
  secureCookies: production,
  devCredit: !production && process.env.DEV_CREDIT === "1",
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`voila-backend on http://localhost:${port} (db: ${process.env.DATABASE_URL ? "postgres" : "pglite ./.data/pglite"}, origins: ${allowedOrigins.join(" ")})`);
});
