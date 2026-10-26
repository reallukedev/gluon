import "server-only";
import { all, db, one, run } from "../../db";
import type { CheckPlanItem, CheckResult, CheckupDiffItem, CheckupKind, CheckupMeta, CheckupRun, CheckupRunRow, CheckupSummary, CheckState } from "@/lib/diagnostics-types";

/** Stored checkup runs (at most KEEP), so people can compare with last time. */

const KEEP = 50;

type G = typeof globalThis & { __gluonCheckupTable?: boolean };
const g = globalThis as G;

/** Same DDL as migration 11, for a server that hasn't restarted since it was added. */
function ensureTable() {
  if (g.__gluonCheckupTable) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS checkup_runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, user_id TEXT, username TEXT,
      counts TEXT, verdict TEXT, meta TEXT NOT NULL, plan TEXT NOT NULL, results TEXT NOT NULL, summary TEXT
    );
    CREATE INDEX IF NOT EXISTS checkup_runs_kind ON checkup_runs(kind, target, started_at);
    CREATE INDEX IF NOT EXISTS checkup_runs_started ON checkup_runs(started_at);
  `);
  g.__gluonCheckupTable = true;
}

interface Row {
  id: string;
  kind: CheckupKind;
  target: string | null;
  title: string;
  status: CheckupSummary["status"];
  started_at: number;
  finished_at: number | null;
  user_id: string | null;
  username: string | null;
  counts: string | null;
  verdict: string | null;
  meta: string;
  plan: string;
  results: string;
  summary: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toRow = (r: Row): CheckupRunRow => ({
  id: r.id,
  kind: r.kind,
  target: r.target,
  title: r.title,
  startedAt: r.started_at,
  startedBy: r.username,
  finishedAt: r.finished_at,
  status: r.status,
  counts: parse<Record<CheckState, number> | null>(r.counts, null),
  verdict: r.verdict,
});

const toRun = (r: Row): CheckupRun => ({
  meta: parse<CheckupMeta>(r.meta, { id: r.id, kind: r.kind, target: r.target, title: r.title, layout: "sweep", origin: null, groups: [], startedAt: r.started_at, startedBy: r.username }),
  plan: parse<CheckPlanItem[]>(r.plan, []),
  results: parse<CheckResult[]>(r.results, []),
  summary: parse<CheckupSummary | null>(r.summary, null),
});

/** The last finished run of the same kind and target, for "new since last time". */
export function previousRun(kind: CheckupKind, target: string | null, before: number): CheckupRun | null {
  ensureTable();
  const r = one<Row>(
    "SELECT * FROM checkup_runs WHERE kind = ? AND target IS ? AND status = 'done' AND started_at < ? ORDER BY started_at DESC LIMIT 1",
    kind,
    target,
    before,
  );
  return r ? toRun(r) : null;
}

/** Problems that appeared and problems that went away since `prev`. */
export function diffRuns(prev: CheckupRun, results: CheckResult[]): CheckupSummary["diff"] {
  const bad = (s: CheckState) => s === "fail" || s === "warn";
  const before = new Map(prev.results.map((r) => [r.id, r]));
  const now = new Map(results.map((r) => [r.id, r]));
  const appeared: CheckupDiffItem[] = [];
  const fixed: CheckupDiffItem[] = [];
  for (const r of results) {
    const p = before.get(r.id);
    if (bad(r.state) && (!p || !bad(p.state) || (p.state === "warn" && r.state === "fail"))) appeared.push({ id: r.id, title: r.title, state: r.state });
  }
  for (const p of prev.results) {
    const r = now.get(p.id);
    if (bad(p.state) && r && r.state === "ok") fixed.push({ id: p.id, title: p.title, state: p.state });
  }
  return { previousId: prev.meta.id, previousAt: prev.summary?.finishedAt ?? prev.meta.startedAt, appeared, fixed };
}

export function saveRun(run_: CheckupRun, user: { id: string; username: string } | null) {
  ensureTable();
  const s = run_.summary;
  run(
    `INSERT OR REPLACE INTO checkup_runs (id, kind, target, title, status, started_at, finished_at, user_id, username, counts, verdict, meta, plan, results, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    run_.meta.id,
    run_.meta.kind,
    run_.meta.target,
    run_.meta.title,
    s?.status ?? "failed",
    run_.meta.startedAt,
    s?.finishedAt ?? Date.now(),
    user?.id ?? null,
    user?.username ?? null,
    s ? JSON.stringify(s.counts) : null,
    s?.verdict ?? null,
    JSON.stringify(run_.meta),
    JSON.stringify(run_.plan),
    JSON.stringify(run_.results),
    s ? JSON.stringify(s) : null,
  );
  run(`DELETE FROM checkup_runs WHERE id NOT IN (SELECT id FROM checkup_runs ORDER BY started_at DESC LIMIT ${KEEP})`);
}

export function getRun(id: string): CheckupRun | null {
  ensureTable();
  const r = one<Row>("SELECT * FROM checkup_runs WHERE id = ?", id);
  return r ? toRun(r) : null;
}

export function latestFull(): CheckupRun | null {
  ensureTable();
  const r = one<Row>("SELECT * FROM checkup_runs WHERE kind = 'full' AND status = 'done' ORDER BY started_at DESC LIMIT 1");
  return r ? toRun(r) : null;
}

export function recentRuns(limit = 20): CheckupRunRow[] {
  ensureTable();
  return all<Row>("SELECT id, kind, target, title, status, started_at, finished_at, user_id, username, counts, verdict, '' AS meta, '' AS plan, '' AS results, NULL AS summary FROM checkup_runs ORDER BY started_at DESC LIMIT ?", limit).map(toRow);
}
