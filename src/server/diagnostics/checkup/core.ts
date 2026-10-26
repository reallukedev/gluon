import "server-only";
import type { User } from "../../auth/users";
import type { CheckFix, CheckPlanItem, CheckResult, CheckState } from "@/lib/diagnostics-types";

/**
 * Building blocks for checkups. A check is a named, read-only probe that returns one plain-language
 * result. Checks never change the server: fixed-argument host commands with timeouts, socket probes
 * and reads of data other modules already collect.
 */

export type Outcome = Omit<CheckResult, "id" | "ms"> & {
  /** Open findings whose remedy should be offered as the fix (first one with a remedy wins). */
  findings?: string[];
};

export interface CheckCtx {
  signal: AbortSignal;
  user: User;
  /** Share one expensive probe between checks of the same run. */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface CheckSpec extends CheckPlanItem {
  /** Hard cap for this check (default 30 s). */
  timeoutMs?: number;
  /** Path runs: start only after every hop has finished (e.g. measurements that would disturb them). */
  afterHops?: boolean;
  run: (ctx: CheckCtx) => Promise<Outcome>;
}

export const ok = (title: string, extra: Partial<Outcome> = {}): Outcome => ({ state: "ok", title, ...extra });
export const warn = (title: string, extra: Partial<Outcome> = {}): Outcome => ({ state: "warn", title, ...extra });
export const fail = (title: string, extra: Partial<Outcome> = {}): Outcome => ({ state: "fail", title, ...extra });
export const skip = (title: string, extra: Partial<Outcome> = {}): Outcome => ({ state: "skip", title, ...extra });

export const go = (label: string, href: string): CheckFix => ({ label, action: "", href });
export const act = (label: string, action: string, params?: Record<string, unknown>): CheckFix => ({ label, action, params });

/** The worst of several states (fail > warn > ok > skip). */
export function worst(states: CheckState[]): CheckState {
  if (states.includes("fail")) return "fail";
  if (states.includes("warn")) return "warn";
  if (states.includes("ok")) return "ok";
  return "skip";
}

/** Run `fn` with at most `n` in flight. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export const ms = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "not measured" : n < 10 ? `${Math.round(n * 10) / 10} ms` : `${Math.round(n)} ms`);

/** Evidence lines: "key  value" pairs aligned for the monospace disclosure. */
export function kv(rows: [string, string | number | null | undefined][]): string {
  const w = Math.min(28, Math.max(...rows.map(([k]) => k.length)));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v === null || v === undefined || v === "" ? "none" : v}`).join("\n");
}

export const oneLine = (s: string, max = 300) => s.replace(/\s+/g, " ").trim().slice(0, max);
