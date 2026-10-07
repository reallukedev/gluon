import "server-only";
import { db, now, one, run } from "../db";

/** What the notification watchers have already seen, so a restart never announces old news again. */

let ready = false;
/** Same statements as migration 15 (idempotent), so a running server doesn't need a restart. */
export function ensureNotifyTables() {
  if (ready) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS notify_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS app_image_checks (
      ref TEXT NOT NULL, image_id TEXT NOT NULL, status TEXT NOT NULL, remote_digest TEXT, error TEXT,
      checked_at INTEGER NOT NULL, PRIMARY KEY (ref, image_id)
    ) WITHOUT ROWID;
  `);
  ready = true;
}

export function getState<T>(key: string): T | null {
  ensureNotifyTables();
  const r = one<{ value: string }>("SELECT value FROM notify_state WHERE key = ?", key);
  if (!r) return null;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return null;
  }
}

export function setState(key: string, value: unknown) {
  ensureNotifyTables();
  run(
    "INSERT INTO notify_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    JSON.stringify(value),
    now(),
  );
}

/** Mark something as announced. True the first time only. */
export function firstTime(key: string): boolean {
  ensureNotifyTables();
  return run("INSERT OR IGNORE INTO notify_state (key, value, updated_at) VALUES (?, '1', ?)", `seen:${key}`, now()).changes > 0;
}
