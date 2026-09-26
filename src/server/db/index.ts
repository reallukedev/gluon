import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrations } from "./migrations";

export const DATA_DIR = (process.env.GLUON_DATA ?? process.env.TEND_DATA) ?? "/data";

type G = typeof globalThis & { __gluonDb?: Database.Database };
const g = globalThis as G;

function open(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  adoptLegacyDatabase();
  const db = new Database(path.join(DATA_DIR, "gluon.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Gluon was called Tend; its database was tend.db. Move it (and its WAL files) over once. */
function adoptLegacyDatabase() {
  const legacy = path.join(DATA_DIR, "tend.db");
  const current = path.join(DATA_DIR, "gluon.db");
  if (fs.existsSync(/*turbopackIgnore: true*/ current) || !fs.existsSync(/*turbopackIgnore: true*/ legacy)) return;
  for (const ext of ["", "-wal", "-shm"]) {
    if (fs.existsSync(/*turbopackIgnore: true*/ legacy + ext)) fs.renameSync(/*turbopackIgnore: true*/ legacy + ext, current + ext);
  }
}

function migrate(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM _migrations").all().map((r) => (r as { version: number }).version));
  for (const [i, sql] of migrations.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
    })();
  }
}

export function db(): Database.Database {
  if (!g.__gluonDb) g.__gluonDb = open();
  return g.__gluonDb;
}

/** Typed helpers so call sites stay readable. */
export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export const now = () => Date.now();
