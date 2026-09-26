import "server-only";
import { onStart, every } from "../jobs";
import { AppError, notFound } from "../errors";
import { getFinding } from "../findings";
import type { User } from "../auth/users";
import { audit } from "../audit";

/**
 * Checks look at the machine and call raise()/resolve() from ../findings. Remedies are named
 * server-side actions a finding can offer ("Make permanent", "Free 4.9 GB"). Feature modules register
 * both; the engine schedules checks and runs remedies with auditing.
 */

interface Check {
  name: string;
  intervalMs: number;
  run: () => unknown | Promise<unknown>;
}

export interface RemedyContext {
  user: User;
  params: Record<string, unknown>;
  findingId: string | null;
}

interface RemedyHandler {
  /** Requires fresh re-auth before running. */
  recent?: boolean;
  run: (ctx: RemedyContext) => Promise<{ message: string } | void>;
}

type G = typeof globalThis & { __gluonChecks?: Check[]; __gluonRemedies?: Map<string, RemedyHandler> };
const g = globalThis as G;
const checks = () => (g.__gluonChecks ??= []);
const remedies = () => (g.__gluonRemedies ??= new Map());

export function registerCheck(name: string, intervalMs: number, run: Check["run"]) {
  if (checks().some((c) => c.name === name)) return;
  checks().push({ name, intervalMs, run });
}

export function registerRemedy(action: string, handler: RemedyHandler) {
  remedies().set(action, handler);
}

export function remedyNeedsRecentAuth(action: string): boolean {
  return !!remedies().get(action)?.recent;
}

export async function runRemedy(user: User, action: string, params: Record<string, unknown>, findingId: string | null, where: { ip: string; zone: string }) {
  const h = remedies().get(action);
  if (!h) throw notFound("That fix");
  const finding = findingId ? getFinding(findingId) : null;
  try {
    const r = await h.run({ user, params, findingId });
    audit(user, { action: `remedy.${action}`, target: finding?.subject ?? null, summary: r?.message ?? `Fixed: ${finding?.title ?? action}`, detail: params }, where);
    // Re-run checks soon so the finding clears on its own if the fix worked.
    setTimeout(() => void runAllChecks(), 1500);
    return { message: r?.message ?? "Done." };
  } catch (e) {
    audit(user, { action: `remedy.${action}`, target: finding?.subject ?? null, summary: `Tried to fix: ${finding?.title ?? action}`, detail: { params, error: (e as Error).message }, outcome: "failed" }, where);
    throw e instanceof AppError ? e : new AppError("remedy_failed", (e as Error).message || "The fix didn't work.", 500);
  }
}

let running = false;
export async function runAllChecks() {
  if (running) return;
  running = true;
  try {
    for (const c of checks()) {
      try {
        await c.run();
      } catch (e) {
        console.error(`[gluon] check ${c.name} failed`, e);
      }
    }
  } finally {
    running = false;
  }
}

onStart("alerts-engine", () => {
  // Stagger: give samplers a moment to collect before the first pass.
  setTimeout(() => {
    for (const c of checks()) {
      every(c.intervalMs, c.run, { immediate: true });
    }
  }, 8000);
});
