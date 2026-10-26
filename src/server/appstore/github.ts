import "server-only";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../errors";
import { safeFetch, NetError } from "../integrations/net";
import { git, gitAvailable } from "./repo";
import { newCompose, parseCompose, stringify, addService, setBuild, setPorts, setVolumes, serviceNames } from "@/lib/builder/compose";
import { SERVICE_RE, slugify, BRANCH_RE, GITHUB_OWNER_RE, GITHUB_REPO_RE, repoPathError } from "@/lib/builder/names";
import { pickWebPort } from "@/lib/builder/start";
import type { RepoInspection } from "@/lib/builder-types";

/**
 * Reading a GitHub repository: what's in it (GitHub's API, fast, no clone), its newest commit
 * (git ls-remote), and a shallow clone for building. A token for private repositories is sent as
 * an HTTP header through git's environment (GIT_CONFIG_*), never on a command line, so it doesn't
 * show up in the process list of this host.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string | null;
  path: string;
}

export function validateRef(r: RepoRef) {
  if (!GITHUB_OWNER_RE.test(r.owner) || !GITHUB_REPO_RE.test(r.repo)) throw new AppError("invalid", "That isn't a GitHub repository name. Use owner/repo.", 400, { field: "repo" });
  if (r.branch && !BRANCH_RE.test(r.branch)) throw new AppError("invalid", "That isn't a branch name Gluon can use.", 400, { field: "branch" });
  const pe = repoPathError(r.path);
  if (pe) throw new AppError("invalid", pe, 400, { field: "path" });
}

const cloneUrl = (r: { owner: string; repo: string }) => `https://github.com/${r.owner}/${r.repo}.git`;

function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (!token) return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" };
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
  };
}

async function api<T>(url: string, token: string | undefined, accept = "application/vnd.github+json", maxBytes = 2 * 1024 * 1024): Promise<{ status: number; data: T | null; text: string; headers: Record<string, unknown> }> {
  try {
    const r = await safeFetch(url, {
      policy: "member",
      headers: { Accept: accept, "User-Agent": "Gluon", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeoutMs: 10_000,
      totalMs: 20_000,
      maxBytes,
    });
    const text = r.body.toString("utf8");
    let data: T | null = null;
    if (accept.includes("json")) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    return { status: r.status, data, text, headers: r.headers as Record<string, unknown> };
  } catch (e) {
    if (e instanceof NetError) throw new AppError("github_unreachable", "Gluon can't reach GitHub right now. Check this server's internet connection.", 502);
    throw e;
  }
}

function apiError(status: number, headers: Record<string, unknown>, token: string | undefined, what: string): AppError {
  if (status === 401) return new AppError("github_token", "GitHub didn't accept that token. Check it hasn't expired and can read this repository.", 400, { field: "token" });
  if (status === 403 || status === 429) {
    const reset = Number(headers["x-ratelimit-reset"]);
    const mins = Number.isFinite(reset) ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : null;
    if (headers["x-ratelimit-remaining"] === "0") return new AppError("github_rate", `GitHub's limit for requests without a token is used up${mins ? `; it resets in ${mins} min` : ""}. Add a token to keep going now.`, 429, { field: "token" });
    return new AppError("github_forbidden", token ? "That token can't read this repository." : "GitHub refused. If the repository is private, add a token.", 403, { field: "token" });
  }
  if (status === 404) return new AppError("github_missing", token ? `GitHub has no ${what} by that name that this token can see.` : `GitHub has no public ${what} by that name. If it's private, add a token.`, 404, { field: what === "branch" ? "branch" : "repo" });
  return new AppError("github", `GitHub answered ${status}. Try again in a minute.`, 502);
}

interface RepoMeta {
  full_name: string;
  name: string;
  description: string | null;
  homepage: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  has_issues: boolean;
  owner: { login: string; avatar_url: string };
}

interface ContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const DOCKERFILES = ["Dockerfile", "dockerfile", "Containerfile"];
const ICONS = /^(logo|icon|app-icon|favicon)\.(svg|png|webp|jpe?g)$/i;

const titleize = (s: string) =>
  s
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

export async function inspectRepo(ref: RepoRef, token: string | undefined): Promise<RepoInspection> {
  validateRef(ref);
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  const meta = await api<RepoMeta>(base, token);
  if (meta.status !== 200 || !meta.data) throw apiError(meta.status, meta.headers, token, "repository");
  const m = meta.data;
  const branch = ref.branch || m.default_branch;
  const sha = await api<unknown>(`${base}/commits/${encodeURIComponent(branch)}`, token, "application/vnd.github.sha");
  if (sha.status !== 200) throw sha.status === 404 || sha.status === 422 ? new AppError("github_branch", `There's no branch called “${branch}”.`, 404, { field: "branch" }) : apiError(sha.status, sha.headers, token, "branch");
  const commit = sha.text.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new AppError("github", "GitHub answered with something unexpected. Try again.", 502);

  const dir = ref.path.replace(/^\/+|\/+$/g, "");
  const list = await api<ContentEntry[] | ContentEntry>(`${base}/contents/${dir.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, token);
  if (list.status === 404) throw new AppError("github_path", `There's no folder “${dir}” in ${branch}.`, 404, { field: "path" });
  if (list.status !== 200 || !list.data) throw apiError(list.status, list.headers, token, "folder");
  if (!Array.isArray(list.data)) throw new AppError("github_path", `“${dir}” is a file. Give the folder the app is in.`, 400, { field: "path" });
  const files = list.data.filter((e) => e.type === "file");
  const pick = (names: string[]) => names.map((n) => files.find((f) => f.name === n)).find(Boolean) ?? null;
  const manifestEntry = files.find((f) => f.name === "umbrel-app.yml") ?? null;
  const composeEntry = pick(COMPOSE_NAMES);
  const dockerEntry = pick(DOCKERFILES);

  const raw = async (p: string) => {
    const r = await api<unknown>(`${base}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, token, "application/vnd.github.raw", 1024 * 1024);
    if (r.status !== 200) throw apiError(r.status, r.headers, token, "file");
    return r.text;
  };

  const notes: string[] = [];
  const details: RepoInspection["prefill"]["details"] = {
    name: titleize(m.name),
    tagline: (m.description ?? "").slice(0, 120),
    description: m.description ?? "",
    website: m.homepage && /^https?:\/\//.test(m.homepage) ? m.homepage : m.html_url,
    support: m.has_issues ? `${m.html_url}/issues` : m.html_url,
    developer: m.owner.login,
    icon: m.owner.avatar_url ? `${m.owner.avatar_url}${m.owner.avatar_url.includes("?") ? "&" : "?"}s=256` : null,
    version: `${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}-${commit.slice(0, 7)}`,
  };
  details.slug = slugify(details.name ?? m.name);
  const web: RepoInspection["prefill"]["web"] = {};
  let compose = "";
  let plan = "";

  if (manifestEntry && composeEntry) {
    const manifestText = await raw(manifestEntry.path);
    const man = parseCompose(manifestText).doc.toJS() as Record<string, unknown> | null;
    if (man && typeof man === "object") {
      const s = (k: string) => (typeof man[k] === "string" ? (man[k] as string) : undefined);
      details.name = s("name") ?? details.name;
      details.slug = slugify(details.name ?? m.name);
      details.tagline = s("tagline") ?? details.tagline;
      details.description = s("description") ?? details.description;
      details.category = s("category") ?? undefined;
      details.website = s("website") || details.website;
      details.support = s("support") || details.support;
      details.developer = s("developer") || details.developer;
      if (s("version")) details.version = s("version");
      const icon = s("icon");
      if (icon && /^(https?:|data:image\/)/.test(icon)) details.icon = icon;
      // Umbrel's own apps keep their icons in its gallery, not in the manifest.
      else if (ref.owner.toLowerCase() === "getumbrel" && typeof man.id === "string" && /^[a-z0-9-]+$/.test(man.id)) details.icon = `https://getumbrel.github.io/umbrel-apps-gallery/${man.id}/icon.svg`;
      if (typeof man.port === "number") web.port = man.port;
      if (s("path")) web.path = s("path");
    }
    compose = await raw(composeEntry.path);
    plan = `An Umbrel app: Gluon uses its umbrel-app.yml and ${composeEntry.name}.`;
    notes.push("Umbrel app folders set their own web page through app_proxy; Gluon turns that into the Web page settings.");
  } else if (composeEntry) {
    compose = await raw(composeEntry.path);
    const parsed = parseCompose(compose);
    const n = parsed.ok ? serviceNames(parsed.doc).length : 0;
    const built = parsed.ok ? serviceNames(parsed.doc).filter((s) => (parsed.doc.getIn(["services", s, "build"]) ?? null) !== null).length : 0;
    plan = `${composeEntry.name} with ${n} ${n === 1 ? "service" : "services"}${built ? `; Gluon builds ${built === n ? (n === 1 ? "it" : "them") : `${built} of them`} from this repository` : ""}.`;
  } else if (dockerEntry) {
    const dockerfile = await raw(dockerEntry.path);
    const svc = SERVICE_RE.test(slugify(m.name)) ? slugify(m.name) : "app";
    const doc = parseCompose(newCompose(svc, "")).doc;
    doc.deleteIn(["services", svc, "image"]);
    setBuild(doc, svc, { context: ".", dockerfile: dockerEntry.name === "Dockerfile" ? "" : dockerEntry.name, target: "" });
    const { ports, volumes } = dockerfileHints(dockerfile);
    if (ports.length) {
      // The web page opens through the Web page settings; other ports are published as they are.
      const webPort = pickWebPort(ports);
      const rest = ports.filter((p) => !(p.port === webPort && p.proto === "tcp"));
      if (rest.length) setPorts(doc, svc, rest.map((p) => ({ host: p.port, container: p.port, proto: p.proto, ip: "", raw: null })));
      if (webPort) {
        web.service = svc;
        web.containerPort = webPort;
        web.port = webPort;
      }
    }
    if (volumes.length) setVolumes(doc, svc, volumes.map((v) => ({ kind: "data", source: v.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "data", target: v, readOnly: false, raw: null, long: false })));
    compose = stringify(doc);
    plan = `A ${dockerEntry.name}: Gluon builds it on this server and runs it as one service.`;
    if (!ports.length) notes.push("The Dockerfile doesn't EXPOSE a port, so set the web page's port yourself.");
  } else {
    throw new AppError("github_nothing", `Gluon didn't find a Dockerfile, a compose file or an umbrel-app.yml in ${dir ? `“${dir}”` : "the repository's top folder"}. Point it at the folder that has one.`, 404, { field: "path" });
  }

  // Prefer the project's own logo over the owner's avatar when there's one next to the app.
  if (!details.icon?.startsWith("data:") && !(manifestEntry && details.icon && !details.icon.includes("avatars.githubusercontent.com"))) {
    const logo = files.find((f) => ICONS.test(f.name) && f.size < 200_000);
    if (logo) {
      try {
        const bytes = await safeFetch(`${base}/contents/${logo.path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, {
          policy: "member",
          headers: { Accept: "application/vnd.github.raw", "User-Agent": "Gluon", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          maxBytes: 256 * 1024,
          timeoutMs: 10_000,
        });
        if (bytes.status === 200 && bytes.body.length > 0) {
          const ext = logo.name.split(".").pop()!.toLowerCase();
          const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
          details.icon = `data:${mime};base64,${bytes.body.toString("base64")}`;
          notes.push(`Using ${logo.name} from the repository as the icon.`);
        }
      } catch {
        /* keep the avatar */
      }
    }
  }
  if (m.private && !token) notes.push("This repository is private; Gluon needs the token to build it later too.");

  return {
    owner: ref.owner,
    repo: ref.repo,
    branch,
    defaultBranch: m.default_branch,
    path: dir,
    private: m.private,
    commit,
    htmlUrl: m.html_url,
    found: { manifest: manifestEntry?.name ?? null, compose: composeEntry?.name ?? null, dockerfile: dockerEntry?.name ?? null },
    plan,
    prefill: { details, web, compose },
    notes,
  };
}

/** EXPOSE and VOLUME lines of a Dockerfile (final stage wins where it matters little). */
export function dockerfileHints(text: string): { ports: { port: number; proto: "tcp" | "udp" }[]; volumes: string[] } {
  const ports: { port: number; proto: "tcp" | "udp" }[] = [];
  const volumes: string[] = [];
  const joined = text.replace(/\\\r?\n/g, " ");
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.trim();
    const expose = /^EXPOSE\s+(.+)$/i.exec(line);
    if (expose) {
      for (const tok of expose[1]!.split(/\s+/)) {
        const mm = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(tok);
        if (mm && Number(mm[1]) > 0 && Number(mm[1]) < 65536 && !ports.some((p) => p.port === Number(mm[1]))) ports.push({ port: Number(mm[1]), proto: (mm[2]?.toLowerCase() as "tcp" | "udp") ?? "tcp" });
      }
    }
    const vol = /^VOLUME\s+(.+)$/i.exec(line);
    if (vol) {
      const v = vol[1]!.trim();
      let list: string[] = [];
      if (v.startsWith("[")) {
        try {
          list = (JSON.parse(v) as unknown[]).map(String);
        } catch {
          list = [];
        }
      } else list = v.split(/\s+/);
      for (const p of list) if (p.startsWith("/") && !p.includes("$") && !volumes.includes(p)) volumes.push(p);
    }
  }
  return { ports, volumes };
}

/** The newest commit on a branch, without cloning. */
export async function latestCommit(ref: { owner: string; repo: string; branch: string }, token: string | undefined): Promise<string> {
  if (await gitAvailable()) {
    try {
      const r = await git(["ls-remote", "--heads", "--", cloneUrl(ref), `refs/heads/${ref.branch}`], { env: gitAuthEnv(token), timeoutMs: 30_000 });
      const sha = r.stdout.trim().split(/\s+/)[0] ?? "";
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      throw new AppError("github_branch", `The branch “${ref.branch}” doesn't exist any more.`, 404);
    } catch (e) {
      if (e instanceof AppError) throw e;
      const msg = (e as Error).message ?? "";
      if (/Authentication failed|could not read Username|403|401/i.test(msg)) throw new AppError("github_token", "GitHub refused the stored token. Update it under Source.", 400);
      if (/not found|Repository not found/i.test(msg)) throw new AppError("github_missing", "GitHub can't find the repository any more.", 404);
      throw new AppError("github_unreachable", "Gluon couldn't ask GitHub for new commits. Try again in a minute.", 502);
    }
  }
  const r = await api<unknown>(`https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.branch)}`, token, "application/vnd.github.sha");
  if (r.status !== 200) throw apiError(r.status, r.headers, token, "branch");
  return r.text.trim();
}

/** Shallow-clone a branch into `dir`; returns the commit it got. */
export async function cloneRepo(ref: { owner: string; repo: string; branch: string }, token: string | undefined, dir: string, onLine: (l: string) => void): Promise<string> {
  if (!(await gitAvailable())) throw new AppError("git_missing", "Gluon's image doesn't include git, which building from GitHub needs. Update Gluon to a newer image.", 500);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  onLine(`Cloning ${ref.owner}/${ref.repo} (${ref.branch})…`);
  try {
    await git(["clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", ref.branch, "--", cloneUrl(ref), dir], {
      env: { ...gitAuthEnv(token), GIT_LFS_SKIP_SMUDGE: "1" },
      timeoutMs: 15 * 60_000,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/Authentication failed|could not read Username/i.test(msg)) throw new AppError("github_token", "GitHub refused to let Gluon clone the repository. Check the token under Source.", 400);
    if (/Remote branch .* not found/i.test(msg)) throw new AppError("github_branch", `The branch “${ref.branch}” doesn't exist.`, 404);
    throw new AppError("clone", `Cloning failed: ${msg.slice(0, 300)}`, 502);
  }
  const sha = (await git(["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  onLine(`Got commit ${sha.slice(0, 7)}.`);
  return sha;
}

export { cloneUrl };
