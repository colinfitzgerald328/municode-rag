import { Pool } from "pg";

// Reuse a single pool across hot-reloads / serverless invocations.
const globalForPg = globalThis as unknown as { _pgPool?: Pool };

export const pool =
  globalForPg._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") globalForPg._pgPool = pool;

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Run a query with EXACT (brute-force) vector + full-text scans instead of the
// approximate HNSW index. The corpus is small (~14k rows, ≤4k per city), so an
// exact scan is fast and — unlike approximate search over a filtered, growing
// index — fully deterministic. This is what keeps retrieval stable and correct
// as more cities are ingested. SET LOCAL requires a transaction.
export async function queryExact<T = any>(
  text: string,
  params: any[]
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_indexscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    const res = await client.query(text, params);
    await client.query("COMMIT");
    return res.rows as T[];
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
