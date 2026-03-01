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

    let ran = 0;
    for (const file of files) {
      const version = file.split("_")[0];
      if (applied.has(version)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      console.log(`Running migration: ${file}`);

      await pool.query(sql);
      await pool.query(
        "INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
        [version, file]
      );
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
