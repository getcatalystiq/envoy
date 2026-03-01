import {
  neon,
  Pool,
  type NeonQueryFunction,
  type PoolClient,
} from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;
let _pool: Pool | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(process.env.DATABASE_URL!);
  }
  return _sql;
}

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  }
  return _pool;
}

// Lazy-initialized tagged template — use sql`...`
// Using a function target so the Proxy's apply trap works
export const sql: NeonQueryFunction<false, false> = new Proxy(
  Object.assign(
    function () {} as unknown as NeonQueryFunction<false, false>
  ),
  {
    apply(_target, _thisArg, args) {
      return getDb().apply(
        null,
        args as Parameters<NeonQueryFunction<false, false>>
      );
    },
    get(_target, prop) {
      return Reflect.get(getDb(), prop);
    },
  }
);

/**
 * Execute a function inside a database transaction using Pool.
 * Automatically commits on success, rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
