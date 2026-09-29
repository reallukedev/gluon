import "server-only";
import { db, one, all, run, now } from "../db";
import { decryptJson, encryptJson, id as newId } from "../crypto";
import type { AppSpec, BuilderSource, BuilderTarget, BuildStatus, CustomAppStatus, GithubSource, PublishedVersion, BuildSummary } from "@/lib/builder-types";

/**
 * The app builder's tables. The same SQL is migration 13 in db/migrations.ts; it's also run here
 * on first use (idempotent) so a running server picks the tables up before its next restart.
 */
export const BUILDER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS custom_apps (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    target TEXT,
    app_id TEXT UNIQUE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL,
    secrets TEXT,
    github TEXT,
    rev INTEGER NOT NULL DEFAULT 1,
    published_version TEXT,
    published_revision INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER,
    published_spec TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS custom_apps_updated ON custom_apps(updated_at);
  CREATE TABLE IF NOT EXISTS custom_app_versions (
    app TEXT NOT NULL REFERENCES custom_apps(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    version TEXT NOT NULL,
    files TEXT NOT NULL,
    store_commit TEXT,
    source_commit TEXT,
    images TEXT,
    published_at INTEGER NOT NULL,
    user_id TEXT,
    username TEXT,
    PRIMARY KEY (app, revision)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS custom_app_builds (
    id TEXT PRIMARY KEY,
    app TEXT NOT NULL REFERENCES custom_apps(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    commit_sha TEXT,
    images TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    user_id TEXT,
    username TEXT
  );
  CREATE INDEX IF NOT EXISTS custom_app_builds_app ON custom_app_builds(app, started_at);
  CREATE TABLE IF NOT EXISTS custom_app_store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    store_id TEXT NOT NULL,
    token TEXT NOT NULL,
    registered_url TEXT,
    registered_at INTEGER,
    created_at INTEGER NOT NULL
  );
`;

type G = typeof globalThis & { __gluonBuilderSchema?: boolean };
const g = globalThis as G;
export function ensureSchema() {
  if (g.__gluonBuilderSchema) return;
  db().exec(BUILDER_SCHEMA);
  g.__gluonBuilderSchema = true;
}

// ---------------------------------------------------------------- apps

interface AppRowRaw {
  id: string;
  source: BuilderSource;
  status: CustomAppStatus;
  target: BuilderTarget | null;
  app_id: string | null;
  slug: string;
  name: string;
  spec: string;
  secrets: string | null;
  github: string | null;
  rev: number;
  published_version: string | null;
  published_revision: number;
  published_at: number | null;
  published_spec: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Stored secrets: env values per service, and the GitHub token. Encrypted as one blob. */
export interface Secrets {
  env: Record<string, Record<string, string>>;
  githubToken?: string;
}

export interface AppRow {
  id: string;
  source: BuilderSource;
  status: CustomAppStatus;
  target: BuilderTarget | null;
  appId: string | null;
  slug: string;
  name: string;
  spec: AppSpec;
  github: Omit<GithubSource, "hasToken"> | null;
  rev: number;
  publishedVersion: string | null;
  publishedRevision: number;
  publishedAt: number | null;
  publishedSpec: AppSpec | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  hasSecrets: boolean;
}

const parse = (r: AppRowRaw): AppRow => ({
  id: r.id,
  source: r.source,
  status: r.status,
  target: r.target,
  appId: r.app_id,
  slug: r.slug,
  name: r.name,
  spec: JSON.parse(r.spec) as AppSpec,
  github: r.github ? (JSON.parse(r.github) as Omit<GithubSource, "hasToken">) : null,
  rev: r.rev,
  publishedVersion: r.published_version,
  publishedRevision: r.published_revision,
  publishedAt: r.published_at,
  publishedSpec: r.published_spec ? (JSON.parse(r.published_spec) as AppSpec) : null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  hasSecrets: !!r.secrets,
});

export function getAppRow(id: string): AppRow | null {
  ensureSchema();
  const r = one<AppRowRaw>("SELECT * FROM custom_apps WHERE id = ?", id);
  return r ? parse(r) : null;
}

export function listAppRows(): AppRow[] {
  ensureSchema();
  return all<AppRowRaw>("SELECT * FROM custom_apps ORDER BY updated_at DESC").map(parse);
}

export function findBySlug(slug: string, except?: string): AppRow | null {
  ensureSchema();
  const r = one<AppRowRaw>("SELECT * FROM custom_apps WHERE slug = ? AND id != ?", slug, except ?? "");
  return r ? parse(r) : null;
}

export function insertApp(input: { source: BuilderSource; spec: AppSpec; github: Omit<GithubSource, "hasToken"> | null; secrets: Secrets | null; userId: string }): string {
  ensureSchema();
  const id = newId(9);
  const t = now();
  run(
    `INSERT INTO custom_apps (id, source, status, slug, name, spec, secrets, github, created_by, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.source,
    input.spec.details.slug,
    input.spec.details.name,
    JSON.stringify(input.spec),
    input.secrets ? encryptJson(input.secrets) : null,
    input.github ? JSON.stringify(input.github) : null,
    input.userId,
    t,
    t,
  );
  return id;
}

export function saveSpec(id: string, spec: AppSpec, extra: { github?: Omit<GithubSource, "hasToken"> | null } = {}) {
  const sets = ["spec = ?", "slug = ?", "name = ?", "rev = rev + 1", "updated_at = ?"];
  const params: unknown[] = [JSON.stringify(spec), spec.details.slug, spec.details.name, now()];
  if (extra.github !== undefined) {
    sets.push("github = ?");
    params.push(extra.github ? JSON.stringify(extra.github) : null);
  }
  run(`UPDATE custom_apps SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return one<{ rev: number; updated_at: number }>("SELECT rev, updated_at FROM custom_apps WHERE id = ?", id)!;
}

export function saveGithub(id: string, github: Omit<GithubSource, "hasToken"> | null) {
  run("UPDATE custom_apps SET github = ? WHERE id = ?", github ? JSON.stringify(github) : null, id);
}

export function readSecrets(id: string): Secrets {
  const r = one<{ secrets: string | null }>("SELECT secrets FROM custom_apps WHERE id = ?", id);
  if (!r?.secrets) return { env: {} };
  try {
    const s = decryptJson<Secrets>(r.secrets);
    return { env: s.env ?? {}, githubToken: s.githubToken };
  } catch {
    // The key changed (data restored without secret.key): the values are gone, the app isn't.
    return { env: {} };
  }
}

export function writeSecrets(id: string, s: Secrets) {
  const empty = Object.values(s.env).every((m) => Object.keys(m).length === 0) && !s.githubToken;
  run("UPDATE custom_apps SET secrets = ?, updated_at = ? WHERE id = ?", empty ? null : encryptJson(s), now(), id);
}

/** `spec` is what was published; the draft carries on from it, with release notes cleared for the next version. */
export function markPublished(id: string, p: { target: BuilderTarget; appId: string; version: string; spec: AppSpec; revision: number }) {
  const draft: AppSpec = { ...p.spec, details: { ...p.spec.details, releaseNotes: "" } };
  run(
    `UPDATE custom_apps SET status = 'published', target = ?, app_id = ?, published_version = ?, published_revision = ?, published_at = ?,
       published_spec = ?, spec = ?, rev = rev + 1, updated_at = ? WHERE id = ?`,
    p.target,
    p.appId,
    p.version,
    p.revision,
    now(),
    JSON.stringify(p.spec),
    JSON.stringify(draft),
    now(),
    id,
  );
}

/** Back to a draft (removed from where it ran); the definition stays. */
export function markUnpublished(id: string) {
  run("UPDATE custom_apps SET status = 'draft', target = NULL, app_id = NULL, rev = rev + 1, updated_at = ? WHERE id = ?", now(), id);
}

export function deleteApp(id: string) {
  run("DELETE FROM custom_apps WHERE id = ?", id);
}

// ---------------------------------------------------------------- versions

export function addVersion(app: string, v: { revision: number; version: string; files: Record<string, string>; storeCommit: string | null; sourceCommit: string | null; images: Record<string, string>; userId: string | null; username: string | null }) {
  run(
    `INSERT INTO custom_app_versions (app, revision, version, files, store_commit, source_commit, images, published_at, user_id, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    app,
    v.revision,
    v.version,
    JSON.stringify(v.files),
    v.storeCommit,
    v.sourceCommit,
    JSON.stringify(v.images),
    now(),
    v.userId,
    v.username,
  );
  // Keep the last 30 versions' files.
  run("DELETE FROM custom_app_versions WHERE app = ? AND revision <= ?", app, v.revision - 30);
}

export function listVersions(app: string): PublishedVersion[] {
  return all<{ revision: number; version: string; published_at: number; username: string | null; store_commit: string | null; source_commit: string | null }>(
    "SELECT revision, version, published_at, username, store_commit, source_commit FROM custom_app_versions WHERE app = ? ORDER BY revision DESC LIMIT 30",
    app,
  ).map((r) => ({ revision: r.revision, version: r.version, publishedAt: r.published_at, username: r.username, storeCommit: r.store_commit, sourceCommit: r.source_commit }));
}

export function latestVersionFiles(app: string): { files: Record<string, string>; images: Record<string, string> } | null {
  const r = one<{ files: string; images: string | null }>("SELECT files, images FROM custom_app_versions WHERE app = ? ORDER BY revision DESC LIMIT 1", app);
  return r ? { files: JSON.parse(r.files) as Record<string, string>, images: r.images ? (JSON.parse(r.images) as Record<string, string>) : {} } : null;
}

/** Images the version before the latest ran with (kept when pruning, for a quick way back). */
export function previousImages(app: string): Record<string, string> {
  const r = one<{ images: string | null }>("SELECT images FROM custom_app_versions WHERE app = ? ORDER BY revision DESC LIMIT 1 OFFSET 1", app);
  return r?.images ? (JSON.parse(r.images) as Record<string, string>) : {};
}

// ---------------------------------------------------------------- builds

export function startBuild(app: string, user: { id: string; username: string } | null): string {
  const bid = newId(9);
  run("INSERT INTO custom_app_builds (id, app, status, started_at, user_id, username) VALUES (?, ?, 'running', ?, ?, ?)", bid, app, now(), user?.id ?? null, user?.username ?? null);
  // Keep 20 builds per app.
  run("DELETE FROM custom_app_builds WHERE app = ? AND id NOT IN (SELECT id FROM custom_app_builds WHERE app = ? ORDER BY started_at DESC LIMIT 20)", app, app);
  return bid;
}

export function finishBuild(bid: string, r: { status: BuildStatus; commit: string | null; images: Record<string, string>; log: string; error: string | null }) {
  run("UPDATE custom_app_builds SET status = ?, commit_sha = ?, images = ?, log = ?, error = ?, finished_at = ? WHERE id = ?", r.status, r.commit, JSON.stringify(r.images), r.log.slice(-400_000), r.error, now(), bid);
}

export function listBuilds(app: string): BuildSummary[] {
  return all<{ id: string; status: BuildStatus; commit_sha: string | null; images: string; started_at: number; finished_at: number | null; error: string | null; username: string | null }>(
    "SELECT id, status, commit_sha, images, started_at, finished_at, error, username FROM custom_app_builds WHERE app = ? ORDER BY started_at DESC LIMIT 20",
    app,
  ).map((b) => ({ id: b.id, status: b.status, commit: b.commit_sha, images: Object.values(JSON.parse(b.images) as Record<string, string>), startedAt: b.started_at, finishedAt: b.finished_at, error: b.error, username: b.username }));
}

/** The newest successful build: its commit and the image each service got. */
export function lastGoodBuild(app: string): { commit: string; images: Record<string, string> } | null {
  const r = one<{ commit_sha: string | null; images: string }>("SELECT commit_sha, images FROM custom_app_builds WHERE app = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1", app);
  return r?.commit_sha ? { commit: r.commit_sha, images: JSON.parse(r.images) as Record<string, string> } : null;
}

export function buildLog(app: string, bid: string): { log: string; status: BuildStatus } | null {
  const r = one<{ log: string; status: BuildStatus }>("SELECT log, status FROM custom_app_builds WHERE app = ? AND id = ?", app, bid);
  return r ?? null;
}

/** Builds left "running" by a restart can't finish any more. */
export function failInterruptedBuilds() {
  ensureSchema();
  run("UPDATE custom_app_builds SET status = 'failed', error = 'Gluon restarted during the build.', finished_at = ? WHERE status = 'running'", now());
}

// ---------------------------------------------------------------- store

export interface StoreRow {
  storeId: string;
  token: string;
  registeredUrl: string | null;
  registeredAt: number | null;
}

export function getStoreRow(): StoreRow | null {
  ensureSchema();
  const r = one<{ store_id: string; token: string; registered_url: string | null; registered_at: number | null }>("SELECT * FROM custom_app_store WHERE id = 1");
  if (!r) return null;
  let token: string;
  try {
    token = decryptJson<string>(r.token);
  } catch {
    return null;
  }
  return { storeId: r.store_id, token, registeredUrl: r.registered_url, registeredAt: r.registered_at };
}

export function createStoreRow(storeId: string, token: string) {
  ensureSchema();
  run("INSERT OR REPLACE INTO custom_app_store (id, store_id, token, created_at) VALUES (1, ?, ?, ?)", storeId, encryptJson(token), now());
}

export function setStoreRegistered(url: string | null) {
  run("UPDATE custom_app_store SET registered_url = ?, registered_at = ? WHERE id = 1", url, url ? now() : null);
}
