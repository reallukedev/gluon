import "server-only";
import { all, now, one, run } from "../db";
import { docker } from "../docker/client";
import { listApps } from "../docker/apps";
import { NetError, safeFetch } from "../integrations/net";
import { ensureNotifyTables } from "../notify/state";
import { compareDigest, MANIFEST_ACCEPT, parseChallenge, planImageCheck, registryHost } from "./registry";

/**
 * Newer images for apps that aren't managed by a store: a cheap daily look at the registry. For
 * each running image tag, ask the registry (anonymously, with HEAD, which Docker Hub doesn't count
 * against its pull limit) which digest the tag points at now, and compare it with the digests the
 * image here was pulled as. Never blocks anything; a registry that says "slow down" is left alone
 * for six hours.
 */

const DAY = 86_400_000;
const PER_RUN = 20;
const BACKOFF_MS = 6 * 3600_000;

export interface RunningImage {
  appId: string;
  appName: string;
  umbrel: boolean;
  container: string;
  ref: string;
  imageId: string;
}

type G = typeof globalThis & {
  __gluonImageInfo?: Map<string, { repoDigests: string[]; labels: Record<string, string> }>;
  __gluonRegistryBackoff?: Map<string, number>;
  __gluonRegistryTokens?: Map<string, { token: string | null; until: number }>;
};
const g = globalThis as G;
const imageInfo = (g.__gluonImageInfo ??= new Map());
const backoff = (g.__gluonRegistryBackoff ??= new Map());
const tokens = (g.__gluonRegistryTokens ??= new Map());

/** Every running container of every app, with the image tag it was started from and the image it runs. */
export async function runningImages(): Promise<RunningImage[]> {
  const apps = await listApps();
  const owner = new Map<string, { id: string; name: string; umbrel: boolean; self: boolean }>();
  for (const a of apps) for (const c of a.containers) owner.set(c.id, { id: a.id, name: a.name, umbrel: !!a.umbrel, self: a.self });
  const raw = await docker().listContainers({ all: false });
  const out: RunningImage[] = [];
  for (const c of raw) {
    const app = owner.get(c.Id);
    if (!app || app.self) continue;
    let ref = c.Image;
    // Docker shows the image id once the tag has moved on (a newer image was pulled but not used yet).
    if (ref.startsWith("sha256:")) {
      try {
        ref = (await docker().getContainer(c.Id).inspect()).Config.Image;
      } catch {
        continue;
      }
    }
    out.push({ appId: app.id, appName: app.name, umbrel: app.umbrel, container: (c.Names?.[0] ?? c.Id).replace(/^\//, ""), ref, imageId: c.ImageID });
  }
  return out;
}

async function info(imageId: string) {
  const hit = imageInfo.get(imageId);
  if (hit) return hit;
  const i = await docker().getImage(imageId).inspect();
  const v = { repoDigests: i.RepoDigests ?? [], labels: (i.Config?.Labels as Record<string, string> | null) ?? {} };
  imageInfo.set(imageId, v);
  if (imageInfo.size > 500) imageInfo.clear();
  return v;
}

const get = (url: string, headers: Record<string, string>, method: "GET" | "HEAD" = "GET") =>
  safeFetch(url, { method, policy: "member", headers: { "User-Agent": "Gluon", ...headers }, timeoutMs: 8000, totalMs: 12_000, maxBytes: 64 * 1024, maxRedirects: 3 });

class Slow extends Error {}

/** An anonymous pull token for one repository (null when the registry needs none). */
async function tokenFor(host: string, repository: string): Promise<string | null> {
  const key = `${host}/${repository}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const ping = await get(`https://${host}/v2/`, {});
  let token: string | null = null;
  if (ping.status === 401) {
    const ch = parseChallenge(String(ping.headers["www-authenticate"] ?? ""));
    if (!ch) throw new Error("the registry wants a sign-in Gluon doesn't have");
    const u = new URL(ch.realm);
    if (ch.service) u.searchParams.set("service", ch.service);
    u.searchParams.set("scope", `repository:${repository}:pull`);
    const r = await get(u.toString(), {});
    if (r.status === 429) throw new Slow();
    if (r.status !== 200) throw new Error(`the registry wouldn't give a pull token (${r.status})`);
    const j = JSON.parse(r.body.toString("utf8")) as { token?: string; access_token?: string; expires_in?: number };
    token = j.token ?? j.access_token ?? null;
    tokens.set(key, { token, until: Date.now() + Math.max(60, Math.min(j.expires_in ?? 300, 3600) - 30) * 1000 });
  } else {
    tokens.set(key, { token: null, until: Date.now() + 3600_000 });
  }
  return token;
}

/** The digest a tag points at right now. */
async function remoteDigest(registry: string, repository: string, tag: string): Promise<string | null> {
  const host = registryHost(registry);
  const tok = await tokenFor(host, repository);
  const r = await get(`https://${host}/v2/${repository}/manifests/${encodeURIComponent(tag)}`, { Accept: MANIFEST_ACCEPT, ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, "HEAD");
  if (r.status === 429) throw new Slow();
  if (r.status === 404) throw new Error(`${registry} has no tag ${tag} of ${repository.replace(/^library\//, "")} any more`);
  if (r.status === 401 || r.status === 403) throw new Error(`${registry} won't say (private, or it needs a sign-in)`);
  if (r.status !== 200) throw new Error(`${registry} answered ${r.status}`);
  const d = r.headers["docker-content-digest"];
  return typeof d === "string" ? d : null;
}

interface CheckRow {
  ref: string;
  image_id: string;
  status: "same" | "newer" | "unknown" | "skipped";
  remote_digest: string | null;
  error: string | null;
  checked_at: number;
}

function save(ref: string, imageId: string, status: CheckRow["status"], remote: string | null, error: string | null) {
  run(
    `INSERT INTO app_image_checks (ref, image_id, status, remote_digest, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref, image_id) DO UPDATE SET status = excluded.status, remote_digest = excluded.remote_digest, error = excluded.error, checked_at = excluded.checked_at`,
    ref,
    imageId,
    status,
    remote,
    error,
    now(),
  );
}

/**
 * Check what's due (each tag at most once a day, a few per run, two at a time). Store apps are left
 * to their store. Returns the images found to have a newer version.
 */
export async function checkAppImages(opts: { max?: number } = {}): Promise<{ checked: number; newer: number }> {
  ensureNotifyTables();
  const images = (await runningImages()).filter((i) => !i.umbrel);
  const seen = new Set<string>();
  const due: { ref: string; imageId: string }[] = [];
  for (const i of images) {
    const key = `${i.ref}|${i.imageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const last = one<{ checked_at: number }>("SELECT checked_at FROM app_image_checks WHERE ref = ? AND image_id = ?", i.ref, i.imageId);
    if (!last || now() - last.checked_at > DAY) due.push({ ref: i.ref, imageId: i.imageId });
  }
  let checked = 0;
  let newer = 0;
  const queue = due.slice(0, opts.max ?? PER_RUN);
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      let plan;
      try {
        const inf = await info(job.imageId);
        plan = planImageCheck(job.ref, inf.repoDigests, inf.labels);
      } catch {
        continue; // the image went away mid-run
      }
      if (!plan.check) {
        save(job.ref, job.imageId, "skipped", null, plan.reason);
        continue;
      }
      if ((backoff.get(plan.registry) ?? 0) > Date.now()) continue;
      try {
        const remote = await remoteDigest(plan.registry, plan.repository, plan.tag);
        const status = compareDigest(plan.local, remote);
        save(job.ref, job.imageId, status, remote, null);
        checked++;
        if (status === "newer") newer++;
      } catch (e) {
        if (e instanceof Slow) {
          backoff.set(plan.registry, Date.now() + BACKOFF_MS);
          continue;
        }
        const msg = e instanceof NetError ? `couldn't reach ${plan.registry} (${e.message})` : (e as Error).message;
        save(job.ref, job.imageId, "unknown", null, msg);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  // Forget checks of images nothing runs any more.
  run("DELETE FROM app_image_checks WHERE checked_at < ?", now() - 30 * DAY);
  return { checked, newer };
}

export interface AppImageUpdate {
  appId: string;
  appName: string;
  ref: string;
  remoteDigest: string;
  checkedAt: number;
}

/** Running images whose tag has moved on, one entry per app and tag. */
export async function appImageUpdates(): Promise<AppImageUpdate[]> {
  ensureNotifyTables();
  const rows = new Map(all<CheckRow>("SELECT * FROM app_image_checks WHERE status = 'newer'").map((r) => [`${r.ref}|${r.image_id}`, r]));
  if (!rows.size) return [];
  const out = new Map<string, AppImageUpdate>();
  for (const i of await runningImages()) {
    const r = rows.get(`${i.ref}|${i.imageId}`);
    if (!r?.remote_digest || i.umbrel) continue;
    out.set(`${i.appId}|${i.ref}`, { appId: i.appId, appName: i.appName, ref: i.ref, remoteDigest: r.remote_digest, checkedAt: r.checked_at });
  }
  return [...out.values()];
}
