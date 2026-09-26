import "server-only";
import fs from "node:fs";
import { docker } from "../docker/client";
import { findUmbrel, umbrelApps, umbrelStores } from "../platform/umbrel";
import type { GithubTarget, Install, RunningBuild, UpdateChannel } from "@/lib/updates-types";
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
  return {
    version: (process.env.GLUON_VERSION ?? "").trim() || pkg.version,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
    build: (process.env.GLUON_BUILD ?? "").trim() || null,
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
  if (res.status === 404) throw Object.assign(new Error("not found"), { status: 404 });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting how often this server can check. Gluon will try again later.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return (await res.json()) as T;
}

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

export async function latestOnGithub(channel: UpdateChannel): Promise<GithubTarget | null> {
  if (channel === "main") {
    const c = await gh<GhCommit>("/commits/main");
    const [title, ...rest] = c.commit.message.split("\n");
    return {
      ref: c.sha,
      version: `main-${c.sha.slice(0, 7)}`,
      commit: c.sha.slice(0, 12),
      title: title ?? "Latest change",
      notes: rest.join("\n").trim(),
      url: c.html_url,
      publishedAt: Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? "") || Date.now(),
    };
  }
  let r: GhRelease;
  try {
    r = await gh<GhRelease>("/releases/latest");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
  const c = await gh<GhCommit>(`/commits/${encodeURIComponent(r.tag_name)}`);
  return {
    ref: r.tag_name,
    version: r.tag_name.replace(/^v/, ""),
    commit: c.sha.slice(0, 12),
    title: r.name?.trim() || `Gluon ${r.tag_name.replace(/^v/, "")}`,
    notes: (r.body ?? "").trim(),
    url: r.html_url,
    publishedAt: Date.parse(r.published_at ?? "") || Date.now(),
  };
}

/** -1 / 0 / 1 for dotted versions ("1.10.0" > "1.9.2"); pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: (main ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function isNewer(target: GithubTarget, running: RunningBuild, channel: UpdateChannel): boolean {
  if (channel === "main") return !running.commit || (!target.commit.startsWith(running.commit.slice(0, 7)) && !running.commit.startsWith(target.commit.slice(0, 7)));
  return compareVersions(target.version, running.version) > 0;
}
