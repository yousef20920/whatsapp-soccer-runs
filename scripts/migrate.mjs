// Applies every SQL file in db/migrations that hasn't run yet, in name order.
// Usage: npm run db:migrate   (reads the database URL from .env.vercel, pulled with `vercel env pull`)

import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) {
  console.error("Missing POSTGRES_URL_NON_POOLING. Run: vercel env pull .env.vercel");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, onnotice: () => {} });
const dir = new URL("../db/migrations/", import.meta.url);

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`;
  await sql`ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY`;
  const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const text = await readFile(new URL(file, dir), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`Applied ${file}`);
  }
  console.log("Database is up to date.");
} finally {
  await sql.end();
}
