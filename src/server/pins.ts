import "server-only";
import { all, now, one, run, tx } from "./db";
import { id as newId } from "./crypto";
import { badRequest } from "./errors";

export type PinKind = "folder" | "app" | "page" | "link";
export interface Pin {
  id: string;
  kind: PinKind;
  target: string;
  label: string;
  position: number;
}

export function listPins(userId: string, kind?: PinKind): Pin[] {
  return kind
    ? all<Pin>("SELECT id, kind, target, label, position FROM pins WHERE user_id = ? AND kind = ? ORDER BY position", userId, kind)
    : all<Pin>("SELECT id, kind, target, label, position FROM pins WHERE user_id = ? ORDER BY kind, position", userId);
}

export function addPin(userId: string, kind: PinKind, target: string, label: string): Pin {
  const existing = one<Pin>("SELECT id, kind, target, label, position FROM pins WHERE user_id = ? AND kind = ? AND target = ?", userId, kind, target);
  if (existing) return existing;
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM pins WHERE user_id = ?", userId)?.n ?? 0;
  if (count >= 60) throw badRequest("That's a lot of pins. Remove a few first.");
  const pos = (one<{ p: number | null }>("SELECT MAX(position) AS p FROM pins WHERE user_id = ? AND kind = ?", userId, kind)?.p ?? -1) + 1;
  const pin = { id: newId(), kind, target, label: label.slice(0, 60), position: pos };
  run("INSERT INTO pins (id, user_id, kind, target, label, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", pin.id, userId, kind, target, pin.label, pos, now());
  return pin;
}

export function removePin(userId: string, id: string) {
  run("DELETE FROM pins WHERE user_id = ? AND id = ?", userId, id);
}

export function renamePin(userId: string, id: string, label: string) {
  run("UPDATE pins SET label = ? WHERE user_id = ? AND id = ?", label.slice(0, 60), userId, id);
}

export function reorderPins(userId: string, ids: string[]) {
  tx(() => ids.forEach((id, i) => run("UPDATE pins SET position = ? WHERE user_id = ? AND id = ?", i, userId, id)));
}
