import "server-only";
import crypto from "node:crypto";
import { docker } from "../docker/client";
import { hostExists, readHostFile } from "../host/paths";
import { AppError } from "../errors";

/**
 * First-party Umbrel client. umbreld's own CLI authenticates by signing a short-lived HS256 JWT
 * ({ loggedIn: true }) with the secret in Umbrel's data folder and calling its tRPC API; Gluon does
 * the same over plain HTTP, so it never needs the user's Umbrel password. Works with umbrelOS on
 * the host (umbreld on :80, data in /home/umbrel/umbrel) and with Umbrel in a container (the
 * container that mounts a folder holding secrets/jwt and publishes port 80).
 */

export interface UmbrelEndpoint {
  url: string;
  dataDir: string;
  container: string | null;
}

type G = typeof globalThis & { __gluonUmbrel?: { at: number; value: UmbrelEndpoint | null } };
const g = globalThis as G;

const NATIVE_ROOTS = ["/home/umbrel/umbrel", "/umbrel"];

export async function findUmbrel(fresh = false): Promise<UmbrelEndpoint | null> {
  const c = g.__gluonUmbrel;
  if (!fresh && c && Date.now() - c.at < 60_000) return c.value;
  let value: UmbrelEndpoint | null = null;
  try {
    for (const ctr of await docker().listContainers()) {
      const port = ctr.Ports?.find((p) => p.PrivatePort === 80 && p.Type === "tcp" && p.PublicPort)?.PublicPort;
      if (!port) continue;
      const mount = ctr.Mounts?.find((m) => m.Source && hostExists(`${m.Source}/secrets/jwt`));
      if (!mount) continue;
      value = { url: `http://127.0.0.1:${port}`, dataDir: mount.Source, container: (ctr.Names?.[0] ?? "").replace(/^\//, "") || null };
      break;
    }
  } catch {
    /* Docker down: fall through to a native install */
  }
  if (!value) {
    const root = NATIVE_ROOTS.find((r) => hostExists(`${r}/secrets/jwt`));
    if (root) value = { url: "http://127.0.0.1:80", dataDir: root, container: null };
  }
  g.__gluonUmbrel = { at: Date.now(), value };
  return value;
}

function token(dataDir: string): string {
  const secret = readHostFile(`${dataDir}/secrets/jwt`).trim();
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ loggedIn: true, iat: now, exp: now + 120 })}`;
  return `${head}.${crypto.createHmac("sha256", secret).update(head).digest("base64url")}`;
}

async function call<T>(path: string, input?: unknown, opts: { mutation?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const ep = await findUmbrel();
  if (!ep) throw new AppError("umbrel_missing", "Gluon can't find Umbrel on this server.", 503);
  const q = !opts.mutation && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  let res: Response;
  try {
    res = await fetch(`${ep.url}/trpc/${path}${q}`, {
      method: opts.mutation ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token(ep.dataDir)}`, ...(opts.mutation ? { "Content-Type": "application/json" } : {}) },
      body: opts.mutation ? JSON.stringify(input ?? null) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch {
    findUmbrel(true).catch(() => undefined);
    throw new AppError("umbrel_unreachable", "Umbrel isn't answering. It may be restarting.", 503);
  }
  const body = (await res.json().catch(() => null)) as { result?: { data: T }; error?: { message?: string } } | null;
  if (!res.ok || !body || body.error) {
    throw new AppError("umbrel", body?.error?.message ? `Umbrel said: ${body.error.message}` : `Umbrel answered ${res.status}.`, 502);
  }
  return body.result!.data;
}

// ---------------------------------------------------------------- types

export type UmbrelAppState =
  | "unknown" | "installing" | "starting" | "running" | "ready" | "stopping" | "stopped" | "restarting"
  | "uninstalling" | "updating" | "not-installed";

export interface UmbrelInstalledApp {
  id: string;
  name: string;
  version: string;
  icon: string | null;
  port: number | null;
  path: string;
  state: UmbrelAppState;
}

export interface UmbrelStoreApp {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  releaseNotes: string;
  category: string;
  developer: string;
  website: string | null;
  icon: string;
  gallery: string[];
  port: number | null;
  dependencies: string[];
  storeId: string;
}

export interface UmbrelStore {
  id: string;
  name: string;
  url: string;
  official: boolean;
  apps: UmbrelStoreApp[];
}

// ---------------------------------------------------------------- reads

const GALLERY = "https://getumbrel.github.io/umbrel-apps-gallery";

export async function umbrelVersion(): Promise<string | null> {
  const v = await call<{ version?: string; name?: string }>("system.version").catch(() => null);
  return v?.name ?? (v?.version ? `umbrelOS ${v.version}` : null);
}

let listCache: { at: number; value: UmbrelInstalledApp[] } | null = null;

/** Installed apps with their Umbrel state. Cached briefly: the app list polls this. */
export async function umbrelApps(maxAgeMs = 5_000): Promise<UmbrelInstalledApp[]> {
  if (listCache && Date.now() - listCache.at < maxAgeMs) return listCache.value;
  const raw = await call<Record<string, unknown>[]>("apps.list");
  const value = raw.map((a) => ({
    id: String(a.id),
    name: String(a.name ?? a.id),
    version: String(a.version ?? ""),
    icon: typeof a.icon === "string" && a.icon ? a.icon : `${GALLERY}/${a.id}/icon.svg`,
    port: typeof a.port === "number" ? a.port : null,
    path: typeof a.path === "string" ? a.path : "",
    state: (typeof a.state === "string" ? a.state : "unknown") as UmbrelAppState,
  }));
  listCache = { at: Date.now(), value };
  return value;
}

let storeCache: { at: number; value: UmbrelStore[] } | null = null;

export async function umbrelStores(maxAgeMs = 60_000): Promise<UmbrelStore[]> {
  if (storeCache && Date.now() - storeCache.at < maxAgeMs) return storeCache.value;
  const raw = await call<{ url: string; meta?: { id?: string; name?: string }; apps?: Record<string, unknown>[] }[]>("appStore.registry", undefined, { timeoutMs: 30_000 });
  const value = raw.map((repo) => {
    const official = /github\.com\/getumbrel\/umbrel-apps/.test(repo.url);
    const storeId = repo.meta?.id ?? repo.url;
    return {
      id: storeId,
      name: repo.meta?.name ?? repo.url,
      url: repo.url,
      official,
      apps: (repo.apps ?? []).map((a) => {
        const id = String(a.id);
        const gallery = Array.isArray(a.gallery) ? (a.gallery as unknown[]).map(String) : [];
        return {
          id,
          name: String(a.name ?? id),
          version: String(a.version ?? ""),
          tagline: String(a.tagline ?? ""),
          description: String(a.description ?? ""),
          releaseNotes: String(a.releaseNotes ?? ""),
          category: String(a.category ?? "other"),
          developer: String(a.developer ?? ""),
          website: typeof a.website === "string" && a.website ? a.website : null,
          icon: typeof a.icon === "string" && a.icon ? a.icon : `${GALLERY}/${id}/icon.svg`,
          gallery: gallery.map((f) => (/^(https?:|data:)/.test(f) ? f : `${GALLERY}/${id}/${f}`)),
          port: typeof a.port === "number" ? a.port : null,
          dependencies: Array.isArray(a.dependencies) ? (a.dependencies as unknown[]).map(String) : [],
          storeId,
        };
      }),
    };
  });
  storeCache = { at: Date.now(), value };
  return value;
}

export async function umbrelAppState(appId: string): Promise<{ state: UmbrelAppState; progress: number }> {
  return call("apps.state", { appId });
}

// ---------------------------------------------------------------- actions

export type UmbrelAction = "install" | "uninstall" | "update" | "start" | "stop" | "restart";

/**
 * Starts an Umbrel app action. Install, update and uninstall can run for minutes (image pulls,
 * builds), so the call isn't awaited: the caller polls umbrelAppState for progress. Failures show
 * up there too, as the app falling back to "not-installed" or its previous state.
 */
export async function umbrelAction(appId: string, action: UmbrelAction): Promise<void> {
  listCache = null;
  const long = action === "install" || action === "update" || action === "uninstall";
  const p = call(`apps.${action}`, { appId }, { mutation: true, timeoutMs: long ? 30 * 60_000 : 120_000 });
  if (long) {
    p.catch(() => undefined).finally(() => (listCache = null));
    // Give Umbrel a moment to reject obviously bad requests (unknown app, already installed).
    await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
  } else {
    await p;
  }
}
