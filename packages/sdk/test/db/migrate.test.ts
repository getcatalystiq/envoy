import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "@sdk/db/migrate.js";
import type { SdkPool, SdkQueryResult } from "@sdk/db/pool.js";

/**
 * An in-memory fake of a `pg`-compatible pool that models just enough behavior to drive the
 * migration runner: it tracks which migration versions have been recorded so a re-run sees them
 * via the `SELECT version FROM sdk_schema_migrations` read and skips already-applied files.
 *
 * It records every executed statement so tests can assert ordering (BEGIN/DDL/INSERT/COMMIT) and
 * idempotency. No real DB.
 */
function fakeMigrationPool(opts?: { failOnSql?: RegExp }) {
  const appliedVersions = new Set<string>();
  const executed: string[] = [];

  const handle = async (
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<SdkQueryResult> => {
    executed.push(text);

    // Read the applied set.
    if (/SELECT version FROM sdk_schema_migrations/.test(text)) {
      return {
        rows: [...appliedVersions].sort().map((version) => ({ version })),
      };
    }

    // Record an applied migration (the RECORD_MIGRATION insert carries [version, file]).
    if (/INSERT INTO sdk_schema_migrations/.test(text)) {
      const version = params?.[0] as string;
      appliedVersions.add(version);
      return { rows: [] };
    }

    // Simulate a DDL failure for a targeted statement so we can assert rollback.
    if (opts?.failOnSql && opts.failOnSql.test(text)) {
      throw new Error("simulated DDL failure");
    }

    return { rows: [] };
  };

  const pool: SdkPool = {
    query: vi.fn(handle) as unknown as SdkPool["query"],
  };

  return { pool, executed, appliedVersions };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "envoy-sdk-mig-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): void {
  writeFileSync(join(tmpDir, name), sql, "utf-8");
}

describe("migrate — happy path", () => {
  it("applies all pending files in version order", async () => {
    writeMigration("002_second.sql", "CREATE TABLE b ();");
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    const { pool, executed } = fakeMigrationPool();

    const result = await migrate(pool, { migrationsDir: tmpDir });

    expect(result.applied).toBe(2);
    expect(result.versions).toEqual(["001", "002"]);
    // DDL for 001 must run before DDL for 002.
    const firstIdx = executed.indexOf("CREATE TABLE a ();");
    const secondIdx = executed.indexOf("CREATE TABLE b ();");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("creates the tracking table before reading applied versions", async () => {
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    const { pool, executed } = fakeMigrationPool();

    await migrate(pool, { migrationsDir: tmpDir });

    const createIdx = executed.findIndex((s) =>
      /CREATE TABLE IF NOT EXISTS sdk_schema_migrations/.test(s)
    );
    const selectIdx = executed.findIndex((s) =>
      /SELECT version FROM sdk_schema_migrations/.test(s)
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(createIdx);
  });

  it("wraps each migration in BEGIN/COMMIT with the record insert inside", async () => {
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    const { pool, executed } = fakeMigrationPool();

    await migrate(pool, { migrationsDir: tmpDir });

    const begin = executed.indexOf("BEGIN");
    const ddl = executed.indexOf("CREATE TABLE a ();");
    const commit = executed.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(ddl).toBeGreaterThan(begin);
    // record insert is between DDL and COMMIT
    const recordIdx = executed.findIndex((s) =>
      /INSERT INTO sdk_schema_migrations/.test(s)
    );
    expect(recordIdx).toBeGreaterThan(ddl);
    expect(commit).toBeGreaterThan(recordIdx);
  });
});

describe("migrate — idempotency", () => {
  it("a second run applies nothing (skips already-applied versions)", async () => {
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    const { pool } = fakeMigrationPool();

    const first = await migrate(pool, { migrationsDir: tmpDir });
    expect(first.applied).toBe(1);

    const second = await migrate(pool, { migrationsDir: tmpDir });
    expect(second.applied).toBe(0);
    expect(second.versions).toEqual([]);
  });

  it("only applies the new file when one of two is already applied", async () => {
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    const { pool, appliedVersions } = fakeMigrationPool();
    await migrate(pool, { migrationsDir: tmpDir });

    // Add a second migration and re-run; only 002 should apply.
    writeMigration("002_second.sql", "CREATE TABLE b ();");
    const result = await migrate(pool, { migrationsDir: tmpDir });
    expect(result.versions).toEqual(["002"]);
    expect(appliedVersions.has("001")).toBe(true);
    expect(appliedVersions.has("002")).toBe(true);
  });
});

describe("migrate — failure rolls back and does not record", () => {
  it("rolls back and records nothing when DDL fails", async () => {
    writeMigration("001_bad.sql", "CREATE TABLE boom ();");
    const { pool, executed, appliedVersions } = fakeMigrationPool({
      failOnSql: /CREATE TABLE boom/,
    });

    await expect(migrate(pool, { migrationsDir: tmpDir })).rejects.toThrow(
      /simulated DDL failure/
    );

    expect(executed).toContain("ROLLBACK");
    expect(executed).not.toContain("COMMIT");
    expect(appliedVersions.has("001")).toBe(false);
  });
});

describe("migrate — ignores non-sql files and reports zero for empty dir", () => {
  it("skips files that do not end in .sql", async () => {
    writeMigration("001_first.sql", "CREATE TABLE a ();");
    writeMigration("README.md", "not a migration");
    const { pool } = fakeMigrationPool();
    const result = await migrate(pool, { migrationsDir: tmpDir });
    expect(result.applied).toBe(1);
  });

  it("returns applied=0 when there are no migration files", async () => {
    const { pool } = fakeMigrationPool();
    const result = await migrate(pool, { migrationsDir: tmpDir });
    expect(result.applied).toBe(0);
    expect(result.versions).toEqual([]);
  });
});

describe("shipped 001_core.sql", () => {
  it("applies the real shipped migration against the fake pool", async () => {
    // Resolve the package's own migrations dir from this test file.
    const here = dirname(fileURLToPath(import.meta.url));
    const shippedDir = join(here, "..", "..", "migrations");
    const { pool, executed } = fakeMigrationPool();

    const result = await migrate(pool, { migrationsDir: shippedDir });

    expect(result.versions).toContain("001");
    // The executed DDL must define the documented core tables (R5 bounded table set).
    const ddl = executed.join("\n");
    for (const table of [
      "sdk_contacts",
      "sdk_topic_consent",
      "sdk_program_state",
      "sdk_broadcast_claims",
      "sdk_enrollments",
      "sdk_steps",
    ]) {
      expect(ddl).toContain(table);
    }
  });
});
