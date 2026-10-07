// Coolify: turning API responses into what the Deployments widget draws. Pure, so it can be tested on recorded shapes.
import type { LineState } from "@/lib/types";
import type { CoolifyDeployment, CoolifyDeploymentStatus, CoolifyResource } from "@/lib/widgets-types";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const ts = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  // Coolify (Laravel) sends "2026-10-07T09:12:44.000000Z"; older builds "2026-10-07 09:12:44" in UTC.
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
};

export function deploymentStatus(v: unknown): CoolifyDeploymentStatus {
  switch (String(v ?? "").toLowerCase()) {
    case "queued":
      return "queued";
    case "in_progress":
      return "in_progress";
    case "finished":
      return "finished";
    case "failed":
      return "failed";
    default:
      // "cancelled-by-user" and anything newer
      return "cancelled";
  }
}

/** One row of ApplicationDeploymentQueue (GET /api/v1/deployments, /deployments/applications/{uuid}). */
export function toDeployment(raw: unknown, appName?: string | null): CoolifyDeployment | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const id = str(d.deployment_uuid) ?? (typeof d.id === "number" ? String(d.id) : null);
  if (!id) return null;
  const commit = str(d.commit);
  const message = str(d.commit_message);
  const path = str(d.deployment_url);
  const status = deploymentStatus(d.status);
  const done = status === "finished" || status === "failed" || status === "cancelled";
  return {
    id,
    app: str(d.application_name) ?? appName ?? "An application",
    status,
    commit: commit && commit !== "HEAD" ? commit.slice(0, 7) : null,
    message: message ? message.split(/\r?\n/)[0]!.slice(0, 200) : null,
    startedAt: ts(d.created_at),
    finishedAt: done ? (ts(d.finished_at) ?? ts(d.updated_at)) : null,
    path: path && path.startsWith("/") && !path.startsWith("//") ? path : null,
    server: str(d.server_name),
    trigger: d.is_webhook === true || d.is_webhook === 1 ? "webhook" : d.is_api === true || d.is_api === 1 ? "api" : "manual",
  };
}

/** Coolify's container status ("running:healthy", "exited:unhealthy", "degraded:unhealthy") as a state line. */
export function resourceLine(status: unknown): LineState {
  const [main = "", health = ""] = String(status ?? "").toLowerCase().split(":");
  if (main.startsWith("running")) return health === "unhealthy" ? "unhealthy" : "running";
  if (main.startsWith("degraded")) return "unhealthy";
  if (main.startsWith("restarting") || main.startsWith("starting")) return "starting";
  if (main.startsWith("paused")) return "paused";
  if (main.startsWith("exited") || main.startsWith("stopped") || main.startsWith("dead") || main === "") return "stopped";
  return "unknown";
}

function resourceType(t: unknown): CoolifyResource["type"] {
  const s = String(t ?? "").toLowerCase();
  if (s === "application") return "application";
  if (s === "service") return "service";
  if (s.startsWith("standalone-") || s.includes("database") || /postgres|mysql|mariadb|mongo|redis|keydb|dragonfly|clickhouse/.test(s)) return "database";
  return "other";
}

/** GET /api/v1/resources item. */
export function toResource(raw: unknown): CoolifyResource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.uuid) ?? (typeof r.id === "number" ? String(r.id) : null);
  const name = str(r.name);
  if (!id || !name) return null;
  const status = str(r.status) ?? "unknown";
  return { id, name, type: resourceType(r.type), line: resourceLine(status), status };
}

/** Deployments come as an array or `{ count, deployments }` depending on the endpoint and version. */
export function deploymentList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Array.isArray((v as { deployments?: unknown }).deployments)) return (v as { deployments: unknown[] }).deployments;
  return [];
}

/** Newest first, each deployment once (the running list and an app's history overlap). */
export function mergeRecent(lists: CoolifyDeployment[][], limit: number): CoolifyDeployment[] {
  const seen = new Set<string>();
  const out: CoolifyDeployment[] = [];
  for (const d of lists.flat().sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out.slice(0, limit);
}

/** "4.3.23" from "4.3.23", "v4.0.0-beta.420" or a JSON string. */
export function parseVersion(text: string): string | null {
  const t = text.trim().replace(/^"|"$/g, "");
  const m = /^v?(\d+\.\d+[\w.\-+]*)$/.exec(t);
  return m ? m[1]! : null;
}
