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

// Run a query with a raised pgvector HNSW ef_search so filtered nearest-
// neighbour search stays accurate as the index grows (SET LOCAL needs a txn).
export async function queryHnsw<T = any>(
  text: string,
  params: any[],
  efSearch = 200
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL hnsw.ef_search = ${Number(efSearch) | 0}`);
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
