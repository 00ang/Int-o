import Database from 'better-sqlite3';

/**
 * The web app reads the same SQLite file the CLI writes.
 *
 * Read-only, deliberately. Every mutation in this system is an act with a cost
 * - a model call, an API bill, a judgement recorded - and those belong to the
 * CLI and to the explicit investigate route, not to a page render. A GET that
 * quietly spends money is how you end up afraid to refresh a browser tab.
 */
let handle: Database.Database | null = null;

export function db(): Database.Database {
  if (!handle) {
    const path = process.env.ALLINT_DB ?? '../data/allint.db';
    handle = new Database(path, { readonly: true, fileMustExist: true });
    handle.pragma('journal_mode = WAL');
  }
  return handle;
}
