// Apply the SDK's migrations to the host database (BYO Postgres). Run once before the first drip:
//   DATABASE_URL=... npx tsx scripts/migrate.ts
//
// The SDK ships SQL migrations; the host applies them with its own pool. This mirrors what a real
// host's deploy step does — the SDK never opens its own connection or runs migrations implicitly.

import { Pool } from "pg";

import { migrate } from "@catalystiq/envoy-sdk";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[example] DATABASE_URL is required to run migrations.");
  }
  const pool = new Pool({ connectionString });
  try {
    const result = await migrate(pool);
    // eslint-disable-next-line no-console
    console.log(
      `[example] migrations applied: ${result.applied} (${result.versions.join(", ") || "none pending"})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
