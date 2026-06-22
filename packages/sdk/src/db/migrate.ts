import "server-only";

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SdkPool } from "./pool.js";

// Migration runner (U2 / origin R5, R48, KTD6).
//
// The SDK ships its own `.sql` migrations under `packages/sdk/migrations/`, entirely separate
// from the app's `migrations/` (the app's `scripts/migrate.ts` scans only the app dir and never
// sees these). A host calls `migrate(pool)` from their own deploy step against their own Postgres.
//
// Idempotency is via a tracking table — `sdk_schema_migrations` — mirroring the app's
// `000_migration_tracking.sql`. We read the applied-version set and skip already-applied files,
// so a host re-running migrate on every deploy never re-executes DDL. We do NOT rely on
// `IF NOT EXISTS` alone (that would silently no-op a changed file and hide drift).
//
// The tracking table is namespaced into its own SDK-prefixed name (`sdk_schema_migrations`) so it
// can never collide with the app's `schema_migrations` table in a shared database. Migration
// *versions* are global to one SDK install (the schema itself is single-tenant per install, R7);
// install-level row isolation (KTD7) lives in the data tables via the namespace key, not here.

const TRACKING_TABLE = "sdk_schema_migrations";

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
    version VARCHAR(50) PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    description TEXT
  )
`;

const RECORD_MIGRATION = `INSERT INTO ${TRACKING_TABLE} (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`;

/**
 * Locate the shipped `migrations/` directory. When bundled to `dist/`, the migrations live one
 * level up next to `package.json` (they ship as raw `.sql` assets via the package `files`/`exports`
 * map). We resolve relative to this module so it works from both `src` (tests) and `dist` (runtime).
 *
 * Overridable via `migrationsDir` on `migrate(...)` for tests.
 */
function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/migrate.ts -> ../../migrations ; dist/index.js -> ../migrations.
  // Probing both keeps it correct regardless of bundle layout.
  const candidates = [
    join(here, "..", "..", "migrations"),
    join(here, "..", "migrations"),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      // try next
    }
  }
  // Fall back to the src-relative path; readdir below will surface a clear error if absent.
  return candidates[0];
}

export interface MigrateOptions {
  /** Override the directory the `.sql` files are read from (tests). Defaults to the shipped dir. */
  migrationsDir?: string;
  /** Sink for progress logging. Defaults to a no-op (secrets/PII never flow here, but stay quiet). */
  log?: (message: string) => void;
}

export interface MigrateResult {
  /** Number of migration files applied on this run (0 when already up to date). */
  applied: number;
  /** Versions applied on this run, in order. */
  versions: string[];
}

/**
 * Read and sort the SDK's migration files. A file's *version* is the leading numeric token
 * (`001_core.sql` -> `001`), matching the app convention so ordering is lexical-on-version.
 */
function listMigrationFiles(dir: string): { version: string; file: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ version: file.split("_")[0], file }));
}

/**
 * Apply all pending SDK migrations to the host-supplied pool, idempotently.
 *
 * Each file runs inside its own transaction (BEGIN/COMMIT, ROLLBACK on error) so a partial DDL
 * failure rolls back atomically and never half-applies a migration. The tracking insert is part
 * of the same transaction, so a file is recorded applied only if its DDL committed.
 *
 * Returns the count + versions applied — derived from work actually done, not a driver `rowCount`.
 */
export async function migrate(
  pool: SdkPool,
  options: MigrateOptions = {}
): Promise<MigrateResult> {
  const dir = options.migrationsDir ?? defaultMigrationsDir();
  const log = options.log ?? (() => {});

  // 1. Ensure the tracking table exists (its own CREATE IF NOT EXISTS is safe to re-run).
  await pool.query(CREATE_TRACKING_TABLE);

  // 2. Read the applied set.
  const appliedRows = await pool.query<{ version: string }>(
    `SELECT version FROM ${TRACKING_TABLE} ORDER BY version`
  );
  const applied = new Set(appliedRows.rows.map((r) => r.version));

  // 3. Apply each pending file in its own transaction.
  const files = listMigrationFiles(dir);
  const versions: string[] = [];

  for (const { version, file } of files) {
    if (applied.has(version)) continue;

    const sqlText = readFileSync(join(dir, file), "utf-8");
    log(`[@catalystiq/envoy-sdk] applying migration ${file}`);

    await pool.query("BEGIN");
    try {
      await pool.query(sqlText);
      await pool.query(RECORD_MIGRATION, [version, file]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    versions.push(version);
  }

  if (versions.length === 0) {
    log("[@catalystiq/envoy-sdk] no pending migrations");
  } else {
    log(`[@catalystiq/envoy-sdk] applied ${versions.length} migration(s)`);
  }

  return { applied: versions.length, versions };
}
