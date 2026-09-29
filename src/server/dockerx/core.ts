import "server-only";
import fs from "node:fs";
import type Docker from "dockerode";
import { docker } from "../docker/client";
import { containerLine, listApps, isUmbrelManaged, type AppSummary } from "../docker/apps";
import { findUmbrel } from "../platform/umbrel";
import { activePlatform } from "../platform";
import { AppError } from "../errors";
import type { AppRef, ContainerRef } from "@/lib/docker-types";

/**
 * Shared plumbing for the Docker manager: raw Engine API calls (dockerode leaves out some query
 * options), errors in plain words, and one snapshot of "which container is whose" that images,
 * volumes and networks all hang their "used by" on.
 */

interface DialOpts {
  path: string;
  method: "GET" | "POST" | "DELETE";
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
  /** Resolve with the raw stream instead of parsed JSON. */
  stream?: boolean;
}

/** Call the Engine API directly (docker-modem), for options dockerode doesn't pass through. */
export function dial<T>(o: DialOpts): Promise<T> {
  const modem = docker().modem as unknown as {
    dial: (opts: Record<string, unknown>, cb: (err: unknown, data: unknown) => void) => void;
  };
  return new Promise<T>((resolve, reject) => {
    modem.dial(
      {
        path: `${o.path}?`,
        method: o.method,
        // docker-modem sends `_query` as the query string and `_body` as the JSON body.
        options: { _query: o.query ?? {}, _body: o.body ?? {} },
        isStream: !!o.stream,
        abortSignal: o.signal,
        statusCodes: { 200: true, 201: true, 204: true, 304: true, 400: "bad parameter", 403: "forbidden", 404: "not found", 409: "conflict", 500: "server error", 503: "unavailable" },
      },
      (err, data) => (err ? reject(err) : resolve(data as T)),
    );
  });
}

interface DockerErr {
  statusCode?: number;
  code?: string;
  json?: { message?: string } | null;
  reason?: string;
  message?: string;
}

/** Docker's own message, without its "Error response from daemon:" noise. */
export function dockerMessage(e: unknown): string {
  const err = e as DockerErr;
  const raw = err?.json?.message ?? (typeof err?.json === "string" ? (err.json as string) : null) ?? err?.message ?? "";
  return String(raw)
    .replace(/^\(HTTP code \d+\)\s*[^-]*-\s*/i, "")
    .replace(/^Error response from daemon:\s*/i, "")
    .trim();
}

export function isDockerDown(e: unknown): boolean {
  const code = (e as DockerErr)?.code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EACCES" || code === "ECONNRESET" || code === "EPIPE";
}

export const DOCKER_DOWN_MESSAGE = "Gluon can't reach Docker. Check that Docker is running on the server and that Gluon's container has /var/run/docker.sock mounted.";

/** Turn any Docker failure into an AppError whose message a person can act on. */
export function dockerError(e: unknown, doing: string): AppError {
  if (e instanceof AppError) return e;
  if (isDockerDown(e)) return new AppError("docker_down", DOCKER_DOWN_MESSAGE, 503);
  const status = (e as DockerErr)?.statusCode;
  const msg = dockerMessage(e);
  if (status === 404) return new AppError("not_found", `${doing}: it isn't there any more. The list is refreshed.`, 404);
  if (status === 409) return new AppError("conflict", `${doing}: ${msg || "Docker refused because something is using it."}`, 409);
  return new AppError("docker", `${doing}: ${msg || "Docker didn't say why."}`, status && status >= 400 && status < 500 ? status : 500);
}

// ---------------------------------------------------------------- who is Gluon

type G = typeof globalThis & { __gluonSelfCtr?: string | null };
const g = globalThis as G;

/**
 * The container Gluon itself runs in. With a host cgroup namespace (how Gluon is deployed) the
 * cgroup path carries the container id; otherwise the mount table names Docker's per-container
 * files (hostname, resolv.conf) by id.
 */
export function selfContainerId(): string | null {
  if (g.__gluonSelfCtr !== undefined) return g.__gluonSelfCtr;
  let id: string | null = null;
  try {
    const cg = fs.readFileSync("/proc/self/cgroup", "utf8");
    id = cg.match(/docker[-/]([0-9a-f]{64})/)?.[1] ?? null;
  } catch {
    /* not Linux */
  }
  if (!id) {
    try {
      const mi = fs.readFileSync("/proc/self/mountinfo", "utf8");
      id = mi.match(/\/(?:docker\/)?containers\/([0-9a-f]{64})\//)?.[1] ?? null;
    } catch {
      /* not Linux */
    }
  }
  g.__gluonSelfCtr = id;
  return id;
}

/** Any Gluon install on this server (production, dev copies): never touched from here. */
const GLUON_NAME = /^(gluon|tend)(-dev(-[a-z0-9-]+)?)?$/;

// ---------------------------------------------------------------- the snapshot

export interface Snapshot {
  containers: Docker.ContainerInfo[];
  refs: Map<string, ContainerRef>;
  apps: AppSummary[];
  appById: Map<string, AppSummary>;
  selfId: string | null;
  /** Image ids Gluon's containers (this one and any other Gluon install) run. */
  selfImages: Set<string>;
  umbrelContainer: string | null;
  platform: "umbrel" | "casaos" | "none";
}

export const appRef = (a: AppSummary): AppRef => ({ id: a.id, name: a.name, source: a.source });

function platformOf(c: Docker.ContainerInfo, umbrelName: string | null): "umbrel" | null {
  const name = (c.Names?.[0] ?? "").replace(/^\//, "");
  const project = c.Labels?.["com.docker.compose.project"];
  if (umbrelName && name === umbrelName) return "umbrel";
  // Umbrel's own services (its auth server and Tor proxy) run as the "umbrelc" project.
  if (project === "umbrelc" && isUmbrelManaged(c.Labels ?? {})) return "umbrel";
  if (/^(ghcr\.io\/)?(getumbrel\/(umbrelos|auth-server|tor)|dockurr\/umbrel)(:|@|$)/.test(c.Image ?? "")) return "umbrel";
  return null;
}

let snapCache: { at: number; value: Promise<Snapshot> } | null = null;

export function invalidateSnapshot() {
  snapCache = null;
}

/** Containers with their apps, who Gluon is, and which platform runs here. Cached 2 s. */
export function snapshot(): Promise<Snapshot> {
  if (snapCache && Date.now() - snapCache.at < 2000) return snapCache.value;
  const value = build();
  snapCache = { at: Date.now(), value };
  value.catch(() => {
    snapCache = null;
  });
  return value;
}

async function build(): Promise<Snapshot> {
  let containers: Docker.ContainerInfo[];
  try {
    containers = await docker().listContainers({ all: true });
  } catch (e) {
    throw dockerError(e, "Couldn't list containers");
  }
  const [apps, umbrel, platform] = await Promise.all([
    listApps().catch(() => [] as AppSummary[]),
    findUmbrel().catch(() => null),
    activePlatform().catch(() => "none" as const),
  ]);
  const appOf = new Map<string, AppSummary>();
  for (const a of apps) for (const c of a.containers) appOf.set(c.id, a);
  const selfId = selfContainerId();
  const refs = new Map<string, ContainerRef>();
  const selfImages = new Set<string>();
  for (const c of containers) {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const app = appOf.get(c.Id);
    const self = (!!selfId && c.Id === selfId) || GLUON_NAME.test(name) || !!app?.self;
    if (self) selfImages.add(c.ImageID);
    const health = /\(unhealthy\)/.test(c.Status) ? "unhealthy" : /health: starting/.test(c.Status) ? "starting" : /\(healthy\)/.test(c.Status) ? "healthy" : null;
    refs.set(c.Id, {
      id: c.Id,
      name,
      state: c.State,
      line: containerLine(c.State, health),
      app: app ? appRef(app) : null,
      self,
      platform: platformOf(c, umbrel?.container ?? null),
    });
  }
  return { containers, refs, apps, appById: new Map(apps.map((a) => [a.id, a])), selfId, selfImages, umbrelContainer: umbrel?.container ?? null, platform };
}

/** Find a container by full id, short id or name, from a fresh listing. */
export async function findContainer(idOrName: string): Promise<{ info: Docker.ContainerInfo; ref: ContainerRef; snap: Snapshot }> {
  const snap = await snapshot();
  const key = idOrName.replace(/^\//, "");
  const info =
    snap.containers.find((c) => c.Id === key) ??
    (/^[0-9a-f]{12,64}$/.test(key) ? snap.containers.find((c) => c.Id.startsWith(key)) : undefined) ??
    snap.containers.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, "") === key));
  if (!info) throw new AppError("not_found", "That container doesn't exist any more.", 404);
  return { info, ref: snap.refs.get(info.Id)!, snap };
}

/** Human list of names: "Immich", "Immich and Jellyfin", "Immich, Jellyfin and 3 more". */
export function names(list: string[], max = 3): string {
  const u = [...new Set(list)];
  if (u.length <= 1) return u[0] ?? "";
  if (u.length <= max) return `${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
  return `${u.slice(0, max - 1).join(", ")} and ${u.length - (max - 1)} more`;
}

/** The apps behind some containers, falling back to container names. */
export function usersText(refs: ContainerRef[]): string {
  return names(refs.map((r) => r.app?.name ?? r.name));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
