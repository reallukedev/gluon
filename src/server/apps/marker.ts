import "server-only";
import fs from "node:fs";
import { hostPath } from "../host/paths";

/**
 * `.gluon-app` in an app's folder says Gluon runs it. The builder writes its draft id there; a
 * move writes a JSON line saying where the app came from. Either way Apps shows it as Gluon's.
 */

export interface GluonMarker {
  /** The builder app this folder belongs to, for apps made in Gluon. */
  builderId: string | null;
  movedFrom: { source: string; id: string; name: string } | null;
  /** Identifies one move, so a rollback only ever deletes the folder that move created. */
  moveId: string | null;
}

export const MARKER = ".gluon-app";

export function parseMarker(text: string): GluonMarker {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { from?: { source?: unknown; id?: unknown; name?: unknown }; move?: unknown };
      const f = j.from;
      return {
        builderId: null,
        movedFrom: f && typeof f.id === "string" ? { source: String(f.source ?? ""), id: f.id, name: String(f.name ?? f.id) } : null,
        moveId: typeof j.move === "string" ? j.move : null,
      };
    } catch {
      return { builderId: null, movedFrom: null, moveId: null };
    }
  }
  return { builderId: t || null, movedFrom: null, moveId: null };
}

export function moveMarker(from: { source: string; id: string; name: string }, moveId: string, by: string): string {
  return `${JSON.stringify({ kind: "moved", from, move: moveId, by, at: new Date().toISOString() })}\n`;
}

const cache = new Map<string, { mtime: number; value: GluonMarker }>();

/** The marker in `dir`, or null when there's none. Cached by modification time. */
export function readMarker(dir: string): GluonMarker | null {
  const file = `${dir}/${MARKER}`;
  let st: fs.Stats;
  try {
    st = fs.statSync(hostPath(file));
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.value;
  let value: GluonMarker;
  try {
    value = parseMarker(fs.readFileSync(hostPath(file), "utf8"));
  } catch {
    return null;
  }
  cache.set(file, { mtime: st.mtimeMs, value });
  return value;
}
