import { Pool } from "@neondatabase/serverless";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const migrationsDir = join(__dirname, "..", "migrations");

  try {
    // Ensure schema_migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        description TEXT
      )
    `);

    // Get already-applied migrations
    const { rows } = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    const applied = new Set(rows.map((r: { version: string }) => r.version));

    // Read and sort migration files
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const RECORD_MIGRATION =
      "INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING";

    let ran = 0;
    for (const file of files) {
      const version = file.split("_")[0];
      if (applied.has(version)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      console.log(`Running migration: ${file}`);

      // Run each migration in its own transaction so a partial DDL failure rolls
      // back atomically (and `SET LOCAL` inside the file actually takes effect —
      // it is a no-op outside a transaction). Migrations that manage their own
      // transaction (a standalone `BEGIN;` ... `COMMIT;` — distinct from a
      // PL/pgSQL `DO $$ BEGIN ... END $$` block) are run as-is to avoid nesting.
      const selfManaged = /^\s*BEGIN\s*;/im.test(sql);
      const client = await pool.connect();
      try {
        if (selfManaged) {
          await client.query(sql);
          await client.query(RECORD_MIGRATION, [version, file]);
        } else {
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query(RECORD_MIGRATION, [version, file]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        }
      } finally {
        client.release();
      }
      ran++;
    }

    if (ran === 0) {
      console.log("No pending migrations.");
    } else {
      console.log(`Applied ${ran} migration(s).`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
