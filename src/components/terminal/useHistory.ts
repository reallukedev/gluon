"use client";
import * as React from "react";
import { readHistory, remember, type History } from "@/lib/terminal/history";
import type { TargetId } from "@/lib/terminal/types";

/**
 * Commands typed per place, kept in this browser only (most recent first). Secrets and commands
 * typed with a leading space are never saved.
 */
const key = (userId: string) => `gluon.terminal.history.${userId}`;

function load(userId: string): Record<string, History> {
  try {
    const raw = JSON.parse(localStorage.getItem(key(userId)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, History> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = readHistory(v);
    return out;
  } catch {
    return {};
  }
}

function save(userId: string, all: Record<string, History>) {
  try {
    const kept = Object.fromEntries(Object.entries(all).filter(([, v]) => v.length));
    if (Object.keys(kept).length) localStorage.setItem(key(userId), JSON.stringify(kept));
    else localStorage.removeItem(key(userId));
  } catch {
    /* full or blocked: history just isn't kept */
  }
}

export function useHistory(userId: string, target: TargetId) {
  const [all, setAll] = React.useState<Record<string, History>>({});
  React.useEffect(() => setAll(load(userId)), [userId]);

  const add = React.useCallback(
    (t: TargetId, command: string) => {
      const fresh = load(userId);
      const next = { ...fresh, [t]: remember(fresh[t] ?? [], command) };
      save(userId, next);
      setAll(next);
    },
    [userId],
  );

  const clear = React.useCallback(
    (t: TargetId | "all") => {
      const next = t === "all" ? {} : { ...load(userId), [t]: [] };
      save(userId, next);
      setAll(next);
    },
    [userId],
  );

  const count = Object.values(all).reduce((n, v) => n + v.length, 0);
  return { history: all[target] ?? EMPTY, count, add, clear };
}

const EMPTY: History = [];
