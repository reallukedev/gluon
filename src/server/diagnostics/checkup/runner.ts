import "server-only";
import crypto from "node:crypto";
import { AppError } from "../../errors";
import { audit } from "../../audit";
import { getFinding } from "../../findings";
import { listApps, type AppSummary } from "../../docker/apps";
import type { User } from "../../auth/users";
import { plural } from "@/lib/format";
import type { CheckPlanItem, CheckResult, CheckState, CheckupEvent, CheckupKind, CheckupMeta, CheckupRun, CheckupRunRow, CheckupSummary } from "@/lib/diagnostics-types";
import { limiter, skip, withTimeout, type CheckCtx, type CheckSpec, type Outcome } from "./core";
import { internetChecks } from "./internet";
import { addressChecks } from "./addresses";
import { appChecks } from "./apps";
import { storageChecks } from "./storage";
import { hardwareChecks } from "./hardware";
import { systemChecks } from "./system";
import { securityChecks } from "./security";
import { targetedPlan, type Plan } from "./targeted";
import { diffRuns, previousRun, saveRun } from "./history";

/**
 * Runs checkups. One run per kind+target at a time: a second request for the same thing attaches to
 * the run in progress (and gets everything so far). A run stops when nobody is watching any more.
 */

const MAX_ACTIVE = 4;
const CONCURRENCY = 6;
const DETACH_GRACE_MS = 4000;

interface Listener {
  emit: (e: CheckupEvent) => void;
}

interface Active {
  key: string;
  meta: CheckupMeta;
  plan: CheckPlanItem[];
  specs: CheckSpec[];
  results: Map<string, CheckResult>;
  running: Set<string>;
  summary: CheckupSummary | null;
  listeners: Set<Listener>;
  abort: AbortController;
  user: User;
  where: { ip: string; zone: string };
  subject: string | null;
  detachTimer: ReturnType<typeof setTimeout> | null;
}

type G = typeof globalThis & { __gluonCheckups?: Map<string, Active> };
const g = globalThis as G;
const active = () => (g.__gluonCheckups ??= new Map());

const FULL_GROUPS = [
  { id: "internet", label: "Internet" },
  { id: "addresses", label: "Public addresses" },
  { id: "apps", label: "Apps" },
  { id: "storage", label: "Storage" },
  { id: "hardware", label: "Hardware" },
  { id: "system", label: "System" },
  { id: "security", label: "Security" },
];

async function fullPlan(): Promise<Plan> {
  const list = await listApps().catch(() => [] as AppSummary[]);
  const [appSpecs, storage] = await Promise.all([appChecks(list), storageChecks()]);
  return {
    title: "Full checkup",
    layout: "sweep",
    origin: null,
    groups: FULL_GROUPS,
    specs: [...internetChecks(), ...addressChecks(), ...appSpecs, ...storage, ...hardwareChecks(), ...systemChecks(), ...securityChecks()],
    subject: null,
  };
}

const key = (kind: CheckupKind, target: string | null) => `${kind}:${target ?? ""}`;

function toRow(a: Active): CheckupRunRow {
  return { id: a.meta.id, kind: a.meta.kind, target: a.meta.target, title: a.meta.title, startedAt: a.meta.startedAt, startedBy: a.meta.startedBy, finishedAt: null, status: "running", counts: null, verdict: null };
}

export function activeRuns(): CheckupRunRow[] {
  return [...active().values()].filter((a) => !a.summary).map(toRow);
}

function broadcast(a: Active, e: CheckupEvent) {
  for (const l of a.listeners) {
    try {
      l.emit(e);
    } catch {
      /* listener went away */
    }
  }
}

/** Offer the same fix the Alerts page shows when an open finding matches. */
function finalize(spec: CheckSpec, out: Outcome, took: number): CheckResult {
  const { findings, ...rest } = out;
  let fix = rest.fix ?? null;
  if ((rest.state === "fail" || rest.state === "warn") && findings?.length) {
    for (const id of findings) {
      const f = getFinding(id);
      if (f && !f.resolvedAt && f.remedy) {
        fix = { label: f.remedy.label, action: f.remedy.action, params: f.remedy.params, confirm: f.remedy.confirm, href: f.remedy.href, findingId: f.id };
        break;
      }
    }
  }
  if (rest.state === "ok" || rest.state === "skip") fix = rest.state === "skip" ? (rest.fix ?? null) : null;
  return { id: spec.id, state: rest.state, title: rest.title, detail: rest.detail ?? null, value: rest.value ?? null, evidence: rest.evidence ?? null, fix, ms: Math.round(took) };
}

export function countStates(results: CheckResult[]): Record<CheckState, number> {
  const c: Record<CheckState, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) c[r.state]++;
  return c;
}

export function verdictFor(meta: CheckupMeta, plan: CheckPlanItem[], results: CheckResult[], status: CheckupSummary["status"]): string {
  const c = countStates(results);
  if (status === "cancelled") return `Stopped after ${results.length} of ${plan.length} checks.`;
  if (status === "failed") return "The checkup couldn't finish.";
  const byId = new Map(results.map((r) => [r.id, r]));
  if (meta.layout === "path") {
    const hops = plan.filter((p) => p.hop);
    const broken = hops.find((h) => byId.get(h.id)?.state === "fail");
    if (broken) return `${byId.get(broken.id)!.title.replace(/[.!]$/, "")}.`;
    const detailFails = results.filter((r) => r.state === "fail" && !hops.some((h) => h.id === r.id)).length;
    if (!c.warn && !detailFails) return "Every step works.";
    const n = c.warn + detailFails;
    return `Every step gets through, with ${plural(n, "thing")} to look at.`;
  }
  if (!c.fail && !c.warn) return "Everything checks out.";
  if (!c.fail) return `Nothing is broken; ${plural(c.warn, "thing")} to look at.`;
  return `Found ${plural(c.fail, "problem")}${c.warn ? ` and ${plural(c.warn, "thing")} to look at` : ""}.`;
}

async function execute(a: Active) {
  const signal = a.abort.signal;
  const memo = new Map<string, Promise<unknown>>();
  const ctx: CheckCtx = {
    signal,
    user: a.user,
    memo: <T>(k: string, fn: () => Promise<T>) => {
      if (!memo.has(k)) {
        const p = fn();
        p.catch(() => {});
        memo.set(k, p);
      }
      return memo.get(k) as Promise<T>;
    },
  };
  const runOne = async (spec: CheckSpec) => {
    if (signal.aborted) return;
    a.running.add(spec.id);
    broadcast(a, { type: "begin", id: spec.id });
    const t0 = performance.now();
    let out: Outcome;
    try {
      out = await withTimeout(spec.run(ctx), spec.timeoutMs ?? 30_000, "timeout");
    } catch (e) {
      const msg = (e as Error).message;
      out = msg === "timeout" ? skip(`${spec.label}: didn't finish in time`, { detail: "The probe took too long, so it was left out. Try again in a minute." }) : skip(`${spec.label}: couldn't be checked`, { detail: msg.slice(0, 300) });
      if (msg !== "timeout") console.error(`[gluon] checkup ${spec.id} failed`, e);
    }
    a.running.delete(spec.id);
    if (signal.aborted) return;
    const r = finalize(spec, out, performance.now() - t0);
    a.results.set(r.id, r);
    broadcast(a, { type: "result", result: r });
  };
  const limit = limiter(CONCURRENCY);
  let status: CheckupSummary["status"] = "done";
  // Stopping doesn't wait for probes already in flight; their results are dropped.
  const stopped = new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
  try {
    let work: Promise<unknown>;
    if (a.meta.layout === "path") {
      const hops = a.specs.filter((s) => s.hop);
      const rest = a.specs.filter((s) => !s.hop && !s.afterHops);
      const later = a.specs.filter((s) => !s.hop && s.afterHops);
      work = Promise.all([
        (async () => {
          for (const h of hops) await runOne(h);
          await Promise.all(later.map((s) => limit(() => runOne(s))));
        })(),
        ...rest.map((s) => limit(() => runOne(s))),
      ]);
    } else {
      work = Promise.all(a.specs.map((s) => limit(() => runOne(s))));
    }
    await Promise.race([work, stopped]);
    if (signal.aborted) status = "cancelled";
  } catch (e) {
    console.error("[gluon] checkup failed", e);
    status = "failed";
  }
  const results = a.plan.map((p) => a.results.get(p.id)).filter((r): r is CheckResult => !!r);
  const prev = status === "done" ? previousRun(a.meta.kind, a.meta.target, a.meta.startedAt) : null;
  a.summary = {
    status,
    finishedAt: Date.now(),
    counts: countStates(results),
    verdict: verdictFor(a.meta, a.plan, results, status),
    diff: prev ? diffRuns(prev, results) : null,
  };
  const run: CheckupRun = { meta: a.meta, plan: a.plan, results, summary: a.summary };
  try {
    saveRun(run, a.user);
  } catch (e) {
    console.error("[gluon] couldn't save checkup", e);
  }
  audit(
    a.user,
    {
      action: "diagnostics.checkup",
      summary: status === "cancelled" ? `Stopped a checkup: ${a.meta.title}` : `Ran a checkup: ${a.meta.title}. ${a.summary.verdict}`,
      target: a.subject,
      detail: { id: a.meta.id, kind: a.meta.kind, target: a.meta.target, counts: a.summary.counts },
      outcome: status === "failed" ? "failed" : "ok",
    },
    a.where,
  );
  broadcast(a, { type: "done", summary: a.summary });
  active().delete(a.meta.id);
}

/** Start a checkup, or attach to the same one already running. */
export async function startOrAttach(kind: CheckupKind, target: string | null, user: User, where: { ip: string; zone: string }): Promise<{ run: Active; attached: boolean }> {
  const k = key(kind, target);
  const existing = [...active().values()].find((a) => a.key === k && !a.summary);
  if (existing) return { run: existing, attached: true };
  const running = [...active().values()].filter((a) => !a.summary);
  if (running.length >= MAX_ACTIVE) throw new AppError("busy", `${plural(running.length, "checkup")} ${running.length === 1 ? "is" : "are"} already running. Wait for one to finish, then try again.`, 429);
  const plan = kind === "full" ? await fullPlan() : await targetedPlan(kind, target);
  const id = `ck_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const meta: CheckupMeta = { id, kind, target, title: plan.title, layout: plan.layout, origin: plan.origin, groups: plan.groups, startedAt: Date.now(), startedBy: user.displayName || user.username };
  const items: CheckPlanItem[] = plan.specs.map((s) => ({ id: s.id, group: s.group, label: s.label, ...(s.hop ? { hop: true } : {}), ...(s.sub ? { sub: s.sub } : {}) }));
  // Duplicate ids would collide in the results map; keep the first.
  const seen = new Set<string>();
  const specs = plan.specs.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const a: Active = {
    key: k,
    meta,
    plan: items.filter((p, i) => items.findIndex((x) => x.id === p.id) === i),
    specs,
    results: new Map(),
    running: new Set(),
    summary: null,
    listeners: new Set(),
    abort: new AbortController(),
    user,
    where,
    subject: plan.subject,
    detachTimer: null,
  };
  active().set(id, a);
  void execute(a);
  return { run: a, attached: false };
}

/**
 * Follow a run until it finishes or `signal` aborts. When the last watcher leaves, the run is
 * stopped after a short grace period (a reload re-attaches in time).
 */
export function follow(a: Active, attached: boolean, emit: (e: CheckupEvent) => void, signal: AbortSignal): Promise<void> {
  emit({ type: "start", meta: a.meta, plan: a.plan, results: a.plan.map((p) => a.results.get(p.id)).filter((r): r is CheckResult => !!r), running: [...a.running], attached });
  if (a.summary) {
    emit({ type: "done", summary: a.summary });
    return Promise.resolve();
  }
  if (a.detachTimer) {
    clearTimeout(a.detachTimer);
    a.detachTimer = null;
  }
  return new Promise<void>((resolve) => {
    const l: Listener = {
      emit: (e) => {
        emit(e);
        if (e.type === "done" || e.type === "error") {
          a.listeners.delete(l);
          resolve();
        }
      },
    };
    a.listeners.add(l);
    const leave = () => {
      a.listeners.delete(l);
      if (!a.listeners.size && !a.summary) {
        a.detachTimer = setTimeout(() => {
          if (!a.listeners.size && !a.summary) a.abort.abort();
        }, DETACH_GRACE_MS);
      }
      resolve();
    };
    if (signal.aborted) leave();
    else signal.addEventListener("abort", leave, { once: true });
  });
}

/** Stop a run now (the Stop button), regardless of other watchers. */
export function stopRun(id: string): boolean {
  const a = active().get(id);
  if (!a || a.summary) return false;
  a.abort.abort();
  return true;
}

export function activeRun(id: string) {
  return active().get(id) ?? null;
}
