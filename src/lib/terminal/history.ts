import { historyEntry } from "./redact";

/** One target's commands, most recent first, without repeats. */
export type History = string[];

export const HISTORY_LIMIT = 300;

/** Remember a command: it moves to the front; secrets and space-prefixed commands are skipped. */
export function remember(list: History, command: string): History {
  const entry = historyEntry(command);
  if (!entry) return list;
  return [entry, ...list.filter((c) => c !== entry)].slice(0, HISTORY_LIMIT);
}

/** Read a stored history defensively (it's from localStorage, so anything goes). */
export function readHistory(raw: unknown): History {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string") continue;
    const e = historyEntry(c);
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= HISTORY_LIMIT) break;
  }
  return out;
}
