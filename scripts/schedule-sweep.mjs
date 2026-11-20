// Sets up (or updates) the Supabase pg_cron job that calls /api/sweep once a minute.
// Usage: SWEEP_SECRET=... node --env-file=.env.vercel scripts/schedule-sweep.mjs
// SWEEP_SECRET must match the one in the Vercel project's environment variables.

import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING;
const secret = process.env.SWEEP_SECRET;
const endpoint = process.env.SWEEP_URL ?? "https://sory-five.vercel.app/api/sweep";
if (!url || !secret || !/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error("Needs POSTGRES_URL_NON_POOLING and a letters/digits SWEEP_SECRET.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, onnotice: () => {} });
const command = `SELECT net.http_post(url := '${endpoint}', headers := '{"Authorization": "Bearer ${secret}"}'::jsonb, timeout_milliseconds := 20000)`;
try {
  await sql`SELECT cron.schedule('sory-sweep', '* * * * *', ${command})`;
  console.log("Scheduled sory-sweep: every minute ->", endpoint);
} finally {
  await sql.end();
}
