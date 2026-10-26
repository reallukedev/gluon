import "server-only";
import fs from "node:fs";
import { docker } from "../docker/client";
import { findUmbrel, umbrelApps, umbrelStores } from "../platform/umbrel";
import { isNightlyVersion, type GithubTarget, type Install, type RunningBuild, type UpdateChannel, type UpdateRelation } from "@/lib/updates-types";
import pkg from "../../../package.json";

/**
 * What's running, how it was installed, and what GitHub has. Gluon updates itself by building a
 * newer version from its GitHub repository on this server (or through Umbrel's store), so it needs
 * to know which container is its own and who manages that container.
 */

export const REPO = process.env.GLUON_REPO && /^[\w.-]+\/[\w.-]+$/.test(process.env.GLUON_REPO) ? process.env.GLUON_REPO : "reallukedev/gluon";

const startedAt = Date.now();

export function runningBuild(): RunningBuild {
  const commit = (process.env.GLUON_COMMIT ?? "").trim();
  const version = (process.env.GLUON_VERSION ?? "").trim() || pkg.version;
  return {
    version,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
    build: (process.env.GLUON_BUILD ?? "").trim() || null,
    channel: isNightlyVersion(version) ? "nightly" : "stable",
    startedAt,
  };
}

// ---------------------------------------------------------------- how Gluon is installed

export interface SelfContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
}

/** Gluon's own container, found through the bind mounts Docker gives every container. */
export async function selfContainer(): Promise<SelfContainer | null> {
  let id: string | null = null;
  try {
    id = fs.readFileSync("/proc/self/mountinfo", "utf8").match(/\/containers\/([0-9a-f]{64})\//)?.[1] ?? null;
  } catch {
    /* not in a container */
  }
  try {
    const d = docker();
    const info = id
      ? await d.getContainer(id).inspect()
      : await d
          .getContainer("gluon")
          .inspect()
          .catch(() => null);
    if (!info) return null;
    return { id: info.Id, name: info.Name.replace(/^\//, ""), image: info.Config.Image, labels: info.Config.Labels ?? {} };
  } catch {
    return null;
  }
}

export interface InstallDetail {
  install: Install;
  container: SelfContainer | null;
  /** Compose-managed: where the project lives and which files define it. */
  compose: { workdir: string; project: string; service: string; image: string; configFiles: string[] } | null;
  /** Umbrel-managed: the app's folder on the host and umbreld's container (null = native umbrelOS). */
  umbrel: { appId: string; appDataDir: string; umbrelContainer: string | null } | null;
}

export async function detectInstall(): Promise<InstallDetail> {
  if (process.env.NODE_ENV !== "production") return { install: { kind: "development" }, container: null, compose: null, umbrel: null };
  const c = await selfContainer();
  if (!c) return { install: { kind: "unknown" }, container: null, compose: null, umbrel: null };
  const project = c.labels["com.docker.compose.project"];
  const service = c.labels["com.docker.compose.service"];
  const workdir = c.labels["com.docker.compose.project.working_dir"];
  const configFiles = (c.labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean);
  const compose = project && service && workdir ? { workdir, project, service, image: c.image, configFiles } : null;

  if (project) {
    const ep = await findUmbrel().catch(() => null);
    if (ep) {
      const app = (await umbrelApps().catch(() => [])).find((a) => a.id === project);
      if (app) {
        return {
          install: { kind: "umbrel", appId: app.id, storeVersion: app.version || null },
          container: c,
          compose,
          umbrel: { appId: app.id, appDataDir: `${ep.dataDir}/app-data/${app.id}`, umbrelContainer: ep.container },
        };
      }
    }
  }
  if (compose && workdir.startsWith("/var/lib/casaos/apps/")) return { install: { kind: "casaos", project, service, image: c.image }, container: c, compose, umbrel: null };
  if (compose) return { install: { kind: "compose", project, service, image: c.image }, container: c, compose, umbrel: null };
  return { install: { kind: "docker", container: c.name }, container: c, compose: null, umbrel: null };
}

/** The version Umbrel's app store offers for this app, when it differs from the installed one. */
export async function umbrelStoreVersion(appId: string): Promise<string | null> {
  const stores = await umbrelStores().catch(() => []);
  for (const s of stores) {
    const app = s.apps.find((a) => a.id === appId);
    if (app?.version) return app.version;
  }
  return null;
}

// ---------------------------------------------------------------- GitHub

/*
 * Unauthenticated, GitHub allows 60 requests an hour per address. A background check costs one or
 * two: Stable reads the newest release (plus the commit its tag points at, remembered per tag);
 * Nightly reads main's newest commit, plus package.json and "what changed since yours" once per new
 * commit. Answers about a commit never change, so they're remembered for a day; failures for 10 min.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type G = typeof globalThis & { __gluonGhMemo?: Map<string, { v: unknown; failed: boolean; until: number }> };
const memo = ((globalThis as G).__gluonGhMemo ??= new Map());

async function remember<T>(key: string, ttlMs: number, failTtlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) {
    if (hit.failed) throw hit.v;
    return hit.v as T;
  }
  const put = (v: unknown, failed: boolean, ttl: number) => {
    memo.delete(key);
    if (ttl > 0) memo.set(key, { v, failed, until: Date.now() + ttl });
    // Oldest first: keep the memo small.
    for (const k of memo.keys()) {
      if (memo.size <= 200) break;
      memo.delete(k);
    }
  };
  try {
    const v = await fn();
    put(v, false, ttlMs);
    return v;
  } catch (e) {
    put(e, true, failTtlMs);
    throw e;
  }
}

async function gh<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "Gluon", "X-GitHub-Api-Version": "2022-11-28" };
  const token = process.env.GLUON_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error("Gluon couldn't reach GitHub. Check this server's internet connection.");
  }
  if (res.status === 404 || res.status === 422) throw Object.assign(new Error("not found"), { status: 404 });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting how often this server can check. Gluon will try again later.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Gluon will try again later.`);
  return (await res.json()) as T;
}

const notFound = (e: unknown) => (e as { status?: number }).status === 404;

interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; committer: { date: string } | null; author: { date: string } | null };
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}
interface GhCompare {
  status: "ahead" | "behind" | "identical" | "diverged";
  ahead_by: number;
  behind_by: number;
  commits: GhCommit[];
}

const firstLine = (message: string) => message.split("\n")[0]?.trim() ?? "";

/** The "x.y.z" in package.json at a commit; null when it has none (or no package.json). */
async function packageVersionAt(sha: string): Promise<string | null> {
  return remember(`pkg:${sha}`, DAY, 10 * MIN, async () => {
    try {
      const f = await gh<{ content?: string; encoding?: string }>(`/contents/package.json?ref=${encodeURIComponent(sha)}`);
      if (f.encoding !== "base64" || !f.content) return null;
      const v = (JSON.parse(Buffer.from(f.content, "base64").toString("utf8")) as { version?: unknown }).version;
      return typeof v === "string" ? (v.trim().replace(/^v/, "").match(/^\d+\.\d+\.\d+/)?.[0] ?? null) : null;
    } catch (e) {
      // Missing or unreadable: name the build 0.0.0-nightly…; GitHub unreachable: fail the check,
      // so a build isn't named (and installed) under a stand-in version by accident.
      if (notFound(e) || e instanceof SyntaxError) return null;
      throw e;
    }
  });
}

/** A nightly's name: "<package.json version>-nightly.<yyyymmdd UTC>.<sha7>". Valid as a Docker tag. */
export function nightlyVersion(base: string | null, committedAt: number, sha: string): string {
  const d = new Date(committedAt);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const name = `${base && /^\d+\.\d+\.\d+$/.test(base) ? base : "0.0.0"}-nightly.${ymd}.${sha.slice(0, 7)}`;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : `0.0.0-nightly.${ymd}.${sha.slice(0, 7)}`;
}

/** How `head` relates to `base` on GitHub, remembered per pair; null when GitHub doesn't know one of them. */
async function compareCommits(base: string, head: string): Promise<{ status: GhCompare["status"]; aheadBy: number; titles: string[] } | null> {
  if (!/^[0-9a-f]{7,40}$/.test(base) || !/^[0-9a-f]{7,40}$/.test(head)) return null;
  return remember(`cmp:${base}...${head}`, DAY, 10 * MIN, async () => {
    try {
      const c = await gh<GhCompare>(`/compare/${base}...${head}?per_page=100`);
      const titles = c.commits
        .map((x) => firstLine(x.commit.message))
        .filter(Boolean)
        .reverse()
        .slice(0, 20);
      return { status: c.status, aheadBy: c.ahead_by, titles };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  });
}

/** Nightly: the changes on main since the running commit. Null when that can't be told (costs nothing then). */
export async function changesSince(runningCommit: string | null, target: GithubTarget): Promise<GithubTarget["since"]> {
  if (!runningCommit || sameCommit(runningCommit, target.commit)) return null;
  try {
    const c = await compareCommits(runningCommit, target.ref);
    return c && c.aheadBy > 0 ? { count: c.aheadBy, titles: c.titles } : null;
  } catch {
    return null;
  }
}

export async function latestOnGithub(channel: UpdateChannel): Promise<GithubTarget | null> {
  if (channel === "nightly") {
    let c: GhCommit;
    try {
      c = await gh<GhCommit>("/commits/main");
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
    const at = Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? "") || Date.now();
    const [title, ...rest] = c.commit.message.split("\n");
    return {
      channel,
      ref: c.sha,
      version: nightlyVersion(await packageVersionAt(c.sha), at, c.sha),
      commit: c.sha.slice(0, 12),
      title: title?.trim() || "Latest change",
      notes: rest.join("\n").trim(),
      url: c.html_url,
      publishedAt: at,
      since: null,
    };
  }
  let r: GhRelease;
  try {
    r = await gh<GhRelease>("/releases/latest");
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
  const sha = await remember(`tag:${r.tag_name}`, DAY, 0, async () => (await gh<GhCommit>(`/commits/${encodeURIComponent(r.tag_name)}`)).sha);
  const version = r.tag_name.replace(/^v/, "");
  return {
    channel,
    ref: r.tag_name,
    version,
    commit: sha.slice(0, 12),
    title: r.name?.trim() || `Gluon ${version}`,
    notes: (r.body ?? "").trim(),
    url: r.html_url,
    publishedAt: Date.parse(r.published_at ?? "") || Date.now(),
    since: null,
  };
}

// ---------------------------------------------------------------- comparing versions

function parseVersion(v: string) {
  const s = v.trim().replace(/^v/, "").split("+")[0] ?? "";
  const dash = s.indexOf("-");
  const main = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? null : s.slice(dash + 1);
  return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split(".") : null };
}

/**
 * -1 / 0 / 1 for versions, semver-style: "1.10.0" > "1.9.2"; a pre-release sorts before its
 * release ("1.2.0-nightly.…" < "1.2.0"); pre-release parts compare numerically when they're numbers,
 * so nightlies sort by date ("1.3.0-nightly.20260928.…" < "1.3.0-nightly.20261001.…").
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q)) || (p < q ? -1 : 1);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 40);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/** By name alone: Nightly = a different commit than yours; Stable = a higher version. */
export function isNewer(target: GithubTarget, running: RunningBuild, channel: UpdateChannel): boolean {
  if (channel === "nightly") return !sameCommit(target.commit, running.commit);
  return compareVersions(target.version, running.version) > 0;
}

/**
 * How the newest build relates to what's running. On Stable a nightly can carry the last release's
 * number yet contain everything in it (and more): when the name says "the release is newer", ask
 * GitHub which commit came first. `certain: false` when GitHub couldn't answer; automatic updates
 * then wait rather than risk going backwards.
 */
export async function relate(target: GithubTarget, running: RunningBuild, channel: UpdateChannel): Promise<{ relation: UpdateRelation; certain: boolean }> {
  if (channel === "nightly") return { relation: sameCommit(target.commit, running.commit) ? "current" : "newer", certain: true };
  if (sameCommit(target.commit, running.commit)) return { relation: "current", certain: true };
  const c = compareVersions(target.version, running.version);
  if (c < 0) return { relation: "ahead", certain: true };
  if (c === 0) return { relation: "current", certain: true };
  if (running.channel === "nightly" && running.commit) {
    try {
      const cmp = await compareCommits(target.commit, running.commit);
      if (cmp?.status === "ahead") return { relation: "ahead", certain: true };
      if (cmp?.status === "identical") return { relation: "current", certain: true };
    } catch {
      return { relation: "newer", certain: false };
    }
  }
  return { relation: "newer", certain: true };
}
