import "server-only";
import { all, now, one, run } from "../db";
import { id as newId } from "../crypto";
import { AppError, conflict, notFound } from "../errors";
import { monitorConfigSchema, type MonitorConfig, type MonitorKind } from "@/lib/alerts-types";

interface MonitorRow {
  id: string;
  name: string;
  kind: MonitorKind;
  target: string;
  config: string;
  source: "user" | "auto";
  ref: string | null;
  enabled: number;
  created_at: number;
}

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  target: string;
  config: MonitorConfig;
  source: "user" | "auto";
  ref: string | null;
  enabled: boolean;
  createdAt: number;
}

export function parseMonitorConfig(raw: unknown): MonitorConfig {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  const p = monitorConfigSchema.safeParse(obj ?? {});
  return p.success ? p.data : monitorConfigSchema.parse({});
}

const toMonitor = (r: MonitorRow): Monitor => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  target: r.target,
  config: parseMonitorConfig(r.config),
  source: r.source,
  ref: r.ref,
  enabled: !!r.enabled,
  createdAt: r.created_at,
});

export function getMonitor(id: string): Monitor | null {
  const r = one<MonitorRow>("SELECT * FROM monitors WHERE id = ?", id);
  return r ? toMonitor(r) : null;
}

export function listMonitorRows(): Monitor[] {
  return all<MonitorRow>("SELECT * FROM monitors ORDER BY source = 'auto', name COLLATE NOCASE").map(toMonitor);
}

/** Validate a merged config; throws a field-specific message. */
export function checkConfig(merged: Record<string, unknown>): MonitorConfig {
  const p = monitorConfigSchema.safeParse(merged);
  if (!p.success) {
    const issue = p.error.issues[0];
    const field = issue?.path.join(".");
    throw new AppError("invalid", issue?.message && !issue.message.startsWith("Invalid") ? issue.message : `Check ${field || "the settings"}.`, 400, field ? { field: `config.${field}` } : undefined);
  }
  if (p.data.timeoutSec >= p.data.intervalSec) {
    throw new AppError("invalid", "The timeout has to be shorter than the time between checks.", 400, { field: "config.timeoutSec" });
  }
  return p.data;
}

export function insertMonitor(m: { name: string; kind: MonitorKind; target: string; config: MonitorConfig; source: "user" | "auto"; ref: string | null; enabled: boolean }): Monitor {
  if (m.source === "user") {
    const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM monitors WHERE source = 'user'")?.n ?? 0;
    if (n >= 200) throw conflict("That's the most monitors Gluon keeps. Remove some you don't need first.");
  }
  const id = newId();
  run(
    "INSERT INTO monitors (id, name, kind, target, config, source, ref, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    m.name,
    m.kind,
    m.target,
    JSON.stringify(m.config),
    m.source,
    m.ref,
    m.enabled ? 1 : 0,
    now(),
  );
  return getMonitor(id)!;
}

export function updateMonitorRow(id: string, patch: { name?: string; target?: string; kind?: MonitorKind; config?: MonitorConfig; enabled?: boolean }) {
  const cur = getMonitor(id);
  if (!cur) throw notFound("That monitor");
  run(
    "UPDATE monitors SET name = ?, target = ?, kind = ?, config = ?, enabled = ? WHERE id = ?",
    patch.name ?? cur.name,
    patch.target ?? cur.target,
    patch.kind ?? cur.kind,
    JSON.stringify(patch.config ?? cur.config),
    patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
    id,
  );
  return getMonitor(id)!;
}

export function deleteMonitorRow(id: string) {
  run("DELETE FROM monitor_hours WHERE monitor_id = ?", id);
  run("DELETE FROM monitors WHERE id = ?", id);
}

/** Parse "host:port" / "[v6]:port". */
export function parseHostPort(target: string): { host: string; port: number } | null {
  const m = target.trim().match(/^(\[[0-9a-f:.]+\]|[^\s:/[\]]+):(\d{1,5})$/i);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port };
}
