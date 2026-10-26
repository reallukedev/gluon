import "server-only";
import { all, db, now, one, run, tx } from "../db";
import { decryptJson, encryptJson } from "../crypto";

/** The router's Device Access Code, kept encrypted, and the custom services Gluon made with it. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS router_access (
  gateway TEXT PRIMARY KEY,
  model TEXT,
  code_enc TEXT NOT NULL,
  created_services TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);`;
type G = typeof globalThis & { __gluonRouterSchema?: boolean };
const g = globalThis as G;
function ensure() {
  if (g.__gluonRouterSchema) return;
  db().exec(SCHEMA);
  // Added later: when the router last refused the stored code.
  const cols = db().prepare("PRAGMA table_info(router_access)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "rejected_at")) db().exec("ALTER TABLE router_access ADD COLUMN rejected_at INTEGER");
  if (!cols.some((c) => c.name === "connected_by")) db().exec("ALTER TABLE router_access ADD COLUMN connected_by TEXT");
  g.__gluonRouterSchema = true;
}

/**
 * After the router refuses the stored code, Gluon stops signing in with it (a gateway can lock
 * sign-ins after repeated failures) until the code is entered again, or this long has passed.
 */
export const REJECTED_PAUSE_MS = 6 * 3_600_000;

export interface Access {
  gateway: string;
  model: string | null;
  code: string;
  created: string[];
  /** When the router last refused this code, if it did since the code was entered. */
  rejectedAt: number | null;
  /** Who entered the code, and when. It's one code for the server: nobody else needs to enter it. */
  by: string | null;
  at: number;
}

export function access(gateway: string): Access | null {
  ensure();
  const r = one<{ gateway: string; model: string | null; code_enc: string; created_services: string; rejected_at: number | null; connected_by: string | null; updated_at: number }>("SELECT * FROM router_access WHERE gateway = ?", gateway);
  if (!r) return null;
  try {
    return { gateway: r.gateway, model: r.model, code: decryptJson<{ code: string }>(r.code_enc).code, created: JSON.parse(r.created_services) as string[], rejectedAt: r.rejected_at ?? null, by: r.connected_by ?? null, at: r.updated_at };
  } catch {
    // The server key changed: the code has to be entered again.
    return null;
  }
}

/** Keep a newly entered (and proven) code. Clears any earlier refusal; keeps the services Gluon made. */
export function remember(gateway: string, model: string | null, code: string, by: string) {
  ensure();
  run(
    `INSERT INTO router_access (gateway, model, code_enc, created_services, updated_at, rejected_at, connected_by) VALUES (?, ?, ?, '[]', ?, NULL, ?)
     ON CONFLICT(gateway) DO UPDATE SET model = excluded.model, code_enc = excluded.code_enc, updated_at = excluded.updated_at, rejected_at = NULL, connected_by = excluded.connected_by`,
    gateway,
    model,
    encryptJson({ code }),
    now(),
    by,
  );
}

/**
 * Change only the list of services Gluon made, read and written in one step, so a code entered
 * meanwhile (or a forget) is never undone by a slow router job finishing.
 */
export function updateCreated(gateway: string, change: (list: string[]) => string[]) {
  ensure();
  tx(() => {
    const r = one<{ created_services: string }>("SELECT created_services FROM router_access WHERE gateway = ?", gateway);
    if (!r) return;
    const next = [...new Set(change(JSON.parse(r.created_services) as string[]))];
    run("UPDATE router_access SET created_services = ? WHERE gateway = ?", JSON.stringify(next), gateway);
  });
}

/** The router refused the stored code. Only that code: a new one entered since isn't touched. */
export function markRejected(gateway: string, code: string) {
  const a = access(gateway);
  if (a && a.code === code) run("UPDATE router_access SET rejected_at = ? WHERE gateway = ?", now(), gateway);
}

/** Should Gluon hold off signing in with the stored code? */
export const codeOnHold = (a: Access, at = now()) => a.rejectedAt !== null && at - a.rejectedAt < REJECTED_PAUSE_MS;

export function forget(gateway: string) {
  ensure();
  run("DELETE FROM router_access WHERE gateway = ?", gateway);
}

/** Every router Gluon holds a code for. */
export function storedGateways(): string[] {
  ensure();
  return all<{ gateway: string }>("SELECT gateway FROM router_access").map((r) => r.gateway);
}
