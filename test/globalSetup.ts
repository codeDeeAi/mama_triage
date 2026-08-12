/**
 * Jest global setup — runs once, before any worker starts.
 *
 * Clears the test database so aggregate assertions describe the current run and residue
 * from a previously failing run cannot mask a regression.
 *
 * This must live here rather than in a per-file `beforeAll`: Jest runs test files in
 * parallel workers, so a truncate inside one file would delete rows another file was
 * midway through using. That is exactly the flake this replaces.
 *
 * Only ever touches a database on the local machine.
 */

import { Client } from 'pg';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  if (!isLocal(DATABASE_URL)) return;

  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query(
      `TRUNCATE audit_log, messages, triage_outcomes, eval_results, eval_runs,
                sessions, webhook_events
         RESTART IDENTITY CASCADE`,
    );
  } catch {
    // No database available: the DB-backed specs skip themselves, so this is not fatal.
  } finally {
    await client.end().catch(() => undefined);
  }
}
