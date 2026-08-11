/**
 * PostgreSQL connection pool.
 *
 * A thin wrapper over `pg` that gives every repository the same typed `query` surface and
 * a transaction helper, without any repository needing to know about connection
 * management.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /** First row, or undefined. */
  one<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<R | undefined>;
  /** Run `fn` inside a transaction, rolling back on any throw. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** True when a connection can be established — used by /readyz. */
  healthy(): Promise<boolean>;
}

function wrap(runner: Pool | PoolClient, pool: Pool): Db {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await runner.query<R>(text, params as unknown[]);
      return result.rows;
    },

    async one<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<R | undefined> {
      const result = await runner.query<R>(text, params as unknown[]);
      return result.rows[0];
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, pool));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* the original error is more useful than a rollback failure */
        });
        throw err;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },

    async healthy(): Promise<boolean> {
      try {
        await runner.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createDb(connectionString: string, maxConnections = 10): Db {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle-client error (network drop, DB restart) is emitted on the pool, not on any
  // query. Without a handler, Node treats it as an unhandled error and exits.
  pool.on('error', () => {
    /* handled by the caller's health checks; a dropped idle client is recoverable */
  });

  return wrap(pool, pool);
}
