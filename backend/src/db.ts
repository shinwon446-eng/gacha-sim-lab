/**
 * Database access. Production uses PostgreSQL (DATABASE_URL); local development and
 * tests use PGlite, an embedded PostgreSQL build that needs no installation.
 * Both expose the same two calls, so every ledger query is real PostgreSQL SQL.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction. Any throw rolls back every write made through q. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** In-memory when dataDir is omitted (tests). */
export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.exec(SCHEMA);
  return {
    query: async (sql, params) => ({ rows: (await db.query(sql, params)).rows as never[] }),
    tx: (fn) => db.transaction((t) => fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params)).rows as never[] }) })),
    close: () => db.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(SCHEMA);
  return {
    query: async (sql, params) => ({ rows: (await pool.query(sql, params as unknown[])).rows }),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** BIGINT arrives as string (pg), bigint or number (PGlite). Cents stay far below 2^53. */
export const num = (v: unknown): number => Number(v);
