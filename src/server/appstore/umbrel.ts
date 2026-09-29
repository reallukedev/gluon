import "server-only";
import crypto from "node:crypto";
import { docker } from "../docker/client";
import { readHostFile } from "../host/paths";
import { host } from "../host/exec";
import { AppError } from "../errors";
import { findUmbrel, umbrelApps, umbrelAppState, type UmbrelAppState } from "../platform/umbrel";

/**
 * The parts of Umbrel's tRPC API the builder needs, with results it can wait for. (Gluon's shared
 * Umbrel client starts long actions and walks away; publishing needs to know how they ended.)
 * Authentication is the same as umbreld's own CLI: a short-lived JWT signed with Umbrel's secret.
 */

function jwt(dataDir: string): string {
  const secret = readHostFile(`${dataDir}/secrets/jwt`).trim();
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ loggedIn: true, iat: now, exp: now + 300 })}`;
  return `${head}.${crypto.createHmac("sha256", secret).update(head).digest("base64url")}`;
}

export class UmbrelError extends AppError {}

async function trpc<T>(path: string, input: unknown, opts: { mutation?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const ep = await findUmbrel();
  if (!ep) throw new UmbrelError("umbrel_missing", "Gluon can't find Umbrel on this server.", 503);
  const q = !opts.mutation && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  let res: Response;
  try {
    res = await fetch(`${ep.url}/trpc/${path}${q}`, {
      method: opts.mutation ? "POST" : "GET",
      headers: { Authorization: `Bearer ${jwt(ep.dataDir)}`, ...(opts.mutation ? { "Content-Type": "application/json" } : {}) },
      body: opts.mutation ? JSON.stringify(input ?? null) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    findUmbrel(true).catch(() => undefined);
    if ((e as Error)?.name === "TimeoutError") throw new UmbrelError("umbrel_timeout", "Umbrel took too long to answer.", 504);
    throw new UmbrelError("umbrel_unreachable", "Umbrel isn't answering. It may be restarting; try again in a minute.", 503);
  }
  const body = (await res.json().catch(() => null)) as { result?: { data: T }; error?: { message?: string; json?: { message?: string } } } | null;
  if (!res.ok || !body || body.error) {
    const msg = body?.error?.message ?? body?.error?.json?.message;
    throw new UmbrelError("umbrel", msg ? `Umbrel said: ${msg}` : `Umbrel answered ${res.status}.`, 502, msg ? { umbrel: msg } : undefined);
  }
  return body.result!.data;
}

export interface RegistryRepo {
  url: string;
  meta: { id: string; name: string };
  apps: { id: string; name: string; version: string; port?: number }[];
}

export async function registry(): Promise<RegistryRepo[]> {
  const raw = await trpc<{ url: string; meta?: { id?: string; name?: string }; apps?: Record<string, unknown>[] }[]>("appStore.registry", undefined, { timeoutMs: 30_000 });
  return raw.map((r) => ({
    url: r.url,
    meta: { id: String(r.meta?.id ?? ""), name: String(r.meta?.name ?? r.url) },
    apps: (r.apps ?? []).map((a) => ({ id: String(a.id), name: String(a.name ?? a.id), version: String(a.version ?? ""), port: typeof a.port === "number" ? a.port : undefined })),
  }));
}

/** Umbrel clones the store before it answers, so this fails when Umbrel can't read it. */
export const addRepository = (url: string) => trpc<boolean>("appStore.addRepository", { url }, { mutation: true, timeoutMs: 120_000 });
export const removeRepository = (url: string) => trpc<boolean>("appStore.removeRepository", { url }, { mutation: true, timeoutMs: 30_000 });

export type LongAction = "install" | "update" | "uninstall";

/**
 * Start an install, update or uninstall and keep hold of how it ends. Umbrel's install answers
 * `false` (not an error) when the app fails to come up, so both are reported as a failure.
 */
export function startAction(appId: string, action: LongAction | "stop" | "start"): Promise<{ ok: boolean; error: string | null }> {
  return trpc<boolean>(`apps.${action}`, { appId }, { mutation: true, timeoutMs: 45 * 60_000 }).then(
    (v) => ({ ok: v !== false, error: v === false ? null : null }),
    (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
}

export { umbrelApps, umbrelAppState, findUmbrel, type UmbrelAppState };

/**
 * The address Umbrel reaches Gluon at. Umbrel in a container: the gateway of its Docker network
 * (the host, where Gluon listens with host networking). umbrelOS on the host: loopback.
 */
export async function gluonAddressForUmbrel(): Promise<string | null> {
  const ep = await findUmbrel();
  if (!ep) return null;
  const port = Number(process.env.PORT ?? 8130) || 8130;
  if (!ep.container) return `http://127.0.0.1:${port}`;
  try {
    const info = await docker().getContainer(ep.container).inspect();
    const nets = (info.NetworkSettings?.Networks ?? {}) as Record<string, { Gateway?: string }>;
    const preferred = nets["umbrel_main_network"]?.Gateway || Object.values(nets).find((n) => n.Gateway)?.Gateway;
    if (!preferred) return null;
    return `http://${preferred.includes(":") ? `[${preferred}]` : preferred}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Ask Umbrel's own container to fetch a URL, to prove it can reach the store before registering
 * it. Read-only (an HTTP GET with wget). Returns null when the check can't run (no container, no
 * wget), else whether it worked.
 */
export async function umbrelCanFetch(url: string): Promise<{ ok: boolean; detail: string } | null> {
  const ep = await findUmbrel();
  if (!ep?.container) return null;
  try {
    const exec = await docker().getContainer(ep.container).exec({ Cmd: ["wget", "-q", "-T", "10", "-O", "-", url], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      stream.on("error", () => resolve(Buffer.concat(chunks).toString("latin1")));
      setTimeout(() => resolve(Buffer.concat(chunks).toString("latin1")), 15_000);
    });
    const inspect = await exec.inspect();
    if (inspect.ExitCode === 127 || /not found/i.test(out) && !out.includes("git-upload-pack")) return null;
    return { ok: inspect.ExitCode === 0 && out.includes("# service=git-upload-pack"), detail: out.replace(/[^\x20-\x7e\n]/g, "").trim().slice(-300) };
  } catch {
    return null;
  }
}

/**
 * What Umbrel logged about an app since a moment, for failed installs (Umbrel only says "false").
 * Container: its Docker log. umbrelOS: the umbrel systemd unit's journal.
 */
export async function umbrelLog(appId: string, sinceMs: number): Promise<string[]> {
  const ep = await findUmbrel();
  if (!ep) return [];
  let text = "";
  try {
    if (ep.container) {
      const buf = (await docker().getContainer(ep.container).logs({ stdout: true, stderr: true, since: Math.floor(sinceMs / 1000) - 2, timestamps: false, follow: false })) as unknown as Buffer;
      text = demux(buf);
    } else {
      text = (await host("journalctl", ["-u", "umbrel", "--since", `@${Math.floor(sinceMs / 1000) - 2}`, "--no-pager", "-o", "cat"], { timeoutMs: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    }
  } catch {
    return [];
  }
  const lines = text.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(Boolean);
  // Lines about this app, plus the error lines right after them (stack traces, docker output).
  const out: string[] = [];
  let tail = 0;
  for (const l of lines) {
    if (l.includes(appId)) {
      out.push(l);
      tail = 12;
    } else if (tail > 0 && /error|failed|denied|not found|no such|refused|conflict|allocated|manifest|pull/i.test(l)) {
      out.push(l);
      tail--;
    } else if (tail > 0) tail--;
  }
  return out.slice(-60);
}

/** Docker's multiplexed log stream (8-byte frame headers) to text. */
function demux(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) return String(buf ?? "");
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    if ((type !== 1 && type !== 2) || i + 8 + len > buf.length) return buf.toString("utf8");
    parts.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * The folder Umbrel clones a store into (umbreld's AppRepository.cleanUrl). Umbrel leaves it behind
 * when a store is removed, so Gluon deletes its own store's copy when it unregisters.
 */
export function umbrelStoreFolder(url: string): string {
  const { hostname, pathname } = new URL(url);
  const basename = hostname.split(".")[0];
  const username = pathname.split("/")[1];
  const repository = pathname.split("/")[2]?.replace(/\.git$/, "");
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 8);
  let clean = "";
  if (username && repository) clean += `${username}-${repository}-`;
  clean += `${basename}-${hash}`;
  return clean.toLowerCase().replace(/[^a-zA-Z0-9.-]/g, "");
}

/** Wait for Umbrel to settle an app after a long action. */
export async function followState(
  appId: string,
  settled: (s: UmbrelAppState, seen: Set<UmbrelAppState>) => boolean,
  onChange: (s: UmbrelAppState, progress: number) => void,
  opts: { timeoutMs?: number; action?: Promise<unknown> } = {},
): Promise<UmbrelAppState> {
  const end = Date.now() + (opts.timeoutMs ?? 45 * 60_000);
  const seen = new Set<UmbrelAppState>();
  let last = "";
  let state: UmbrelAppState = "unknown";
  let actionDone = false;
  opts.action?.finally(() => (actionDone = true));
  let misses = 0;
  while (Date.now() < end) {
    const s = await umbrelAppState(appId).catch(() => null);
    if (s) {
      misses = 0;
      state = s.state;
      seen.add(s.state);
      const key = `${s.state}:${Math.round(s.progress)}`;
      if (key !== last) onChange(s.state, s.progress);
      last = key;
      if (settled(s.state, seen)) break;
      // The action returned and Umbrel still shows the app idle: nothing more will happen.
      if (actionDone && (s.state === "ready" || s.state === "running" || s.state === "stopped" || s.state === "not-installed" || s.state === "unknown")) break;
    } else if (++misses > 90) break; // Umbrel gone for three minutes
    await new Promise((r) => setTimeout(r, 2000));
  }
  return state;
}
