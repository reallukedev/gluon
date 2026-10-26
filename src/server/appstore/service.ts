import "server-only";
import fs from "node:fs";
import path from "node:path";
import { AppError, conflict, notFound } from "../errors";
import { audit } from "../audit";
import { publish as publishEvent } from "../events";
import { activePlatform } from "../platform";
import { hostPath, hostExists } from "../host/paths";
import { appFolder, appsRoot, invalidateAppsRoot } from "../apps/root";
import { hostSpawn, lineReader } from "../host/exec";
import { listApps, invalidateApps, lanHost, setAppPrefs } from "../docker/apps";
import { publicBaseUrl } from "../settings";
import { token as newToken } from "../crypto";
import type { User } from "../auth/users";
import {
  addVersion, createStoreRow, deleteApp, ensureSchema, findBySlug, getAppRow, getStoreRow, insertApp, lastGoodBuild, latestVersionFiles, listAppRows, listBuilds,
  listVersions, markPublished, markUnpublished, previousImages, readSecrets, saveGithub, saveSpec, setStoreRegistered, writeSecrets, type AppRow, type Secrets,
} from "./db";
import { commitStore, ensureRepo, gitAvailable, headCommit, withStoreLock } from "./repo";
import {
  addRepository, findUmbrel, followState, gluonAddressForUmbrel, registry, removeRepository, startAction, umbrelApps, umbrelCanFetch, umbrelLog, umbrelStoreFolder,
  type UmbrelAppState,
} from "./umbrel";
import { buildApp, buildServices, imagesPresent, pruneImages } from "./build";
import { latestCommit } from "./github";
import { serverChecks } from "./checks";
import { currentJob, isRunning, startJob, type Emit } from "./jobs";
import { analyze, detailIssues } from "@/lib/builder/analyze";
import { parseCompose, readService, readServices, serviceNames } from "@/lib/builder/compose";
import { envFile, nextVersion, renderApp } from "@/lib/builder/render";
import { STORE_ID_RE, umbrelAppId } from "@/lib/builder/names";
import type {
  AppSpec, BuilderSource, BuilderTarget, CustomAppDetail, CustomAppListItem, GithubSource, Issue, RuntimeState, SecretNames, StoreStatus,
} from "@/lib/builder-types";

type Where = { ip?: string; zone?: string };
const STORE_NAME = "Made with Gluon";

// ---------------------------------------------------------------- where apps go

/**
 * New apps run with Docker Compose from Gluon's own apps folder, on Umbrel too: Gluon starts,
 * updates and removes them directly instead of going through Umbrel's store. Apps already
 * published to Umbrel keep their target (r.target) and keep updating there.
 */
export async function currentTarget(): Promise<BuilderTarget> {
  return "compose";
}

/** Where compose apps live when Gluon runs them itself (see src/server/apps/root.ts). */
export const composeRoot = appsRoot;

/** This app's folder: where it was published before (in any apps root), else a new one. */
const folderFor = (project: string, id: string) => appFolder(project, (m) => m === id);

const gluonUrl = (id: string) => `${publicBaseUrl()}/apps/custom/${id}`;
const repoUrl = (gh: AppRow["github"]) => (gh ? `https://github.com/${gh.owner}/${gh.repo}${gh.path ? `/tree/${gh.branch}/${gh.path}` : ""}` : null);

// ---------------------------------------------------------------- the store

async function storeUrl(): Promise<{ url: string; base: string } | null> {
  const row = getStoreRow();
  if (!row) return null;
  const base = await gluonAddressForUmbrel();
  if (!base) return null;
  return { url: `${base}/api/appstore/${row.token}/${row.storeId}.git`, base };
}

const hideToken = (url: string) => url.replace(/\/api\/appstore\/[^/]+\//, "/api/appstore/•••/");

export async function storeStatus(): Promise<StoreStatus> {
  ensureSchema();
  const platform = await activePlatform().catch(() => "none" as const);
  const row = getStoreRow();
  const status: StoreStatus = {
    platform,
    umbrel: "missing",
    registered: false,
    lost: false,
    storeId: row?.storeId ?? null,
    displayUrl: row?.registeredUrl ? hideToken(row.registeredUrl) : null,
    gitMissing: !(await gitAvailable()),
    composeRoot: await composeRoot(),
  };
  if (platform !== "umbrel") return status;
  if (!(await findUmbrel())) return status;
  try {
    const regs = await registry();
    status.umbrel = "ok";
    if (row?.registeredUrl) {
      const listed = regs.some((r) => r.url === row.registeredUrl);
      status.registered = listed;
      status.lost = !listed;
    }
  } catch {
    status.umbrel = "unreachable";
    status.registered = !!row?.registeredUrl;
  }
  return status;
}

/** A store id no other store in Umbrel uses (app ids must start with it). */
async function pickStoreId(): Promise<string> {
  const taken = new Set((await registry().catch(() => [])).map((r) => r.meta.id));
  for (const id of ["gluon", "gluonapps", ...Array.from({ length: 20 }, (_, i) => `gluon${i + 2}`)]) if (!taken.has(id) && STORE_ID_RE.test(id)) return id;
  throw new AppError("store_id", "Umbrel already has too many stores called gluon.", 409);
}

/** Every published Umbrel app's files, with `override` replacing (or `omit` removing) one. */
function storeContents(override?: { appId: string; files: Record<string, string> }, omit?: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const a of listAppRows()) {
    if (a.status !== "published" || a.target !== "umbrel" || !a.appId || a.appId === omit) continue;
    const v = latestVersionFiles(a.id);
    if (v) out[a.appId] = v.files;
  }
  if (override) out[override.appId] = override.files;
  return out;
}

/**
 * Get the store ready without touching Umbrel: create its id and token, write the repository, and
 * ask Umbrel's container whether it can fetch it (a read-only HTTP GET). The setup dialog shows the
 * result before anything is registered.
 */
export async function prepareStore(): Promise<{ address: string; reachable: boolean | null; detail: string | null; storeId: string }> {
  if ((await activePlatform()) !== "umbrel") throw new AppError("platform", "Gluon's app store is for Umbrel, and Gluon isn't working with Umbrel.", 409);
  if (!(await findUmbrel())) throw new AppError("umbrel_missing", "Gluon can't find Umbrel on this server.", 503);
  return withStoreLock(async () => {
    let row = getStoreRow();
    if (!row) {
      createStoreRow(await pickStoreId(), newToken(32));
      row = getStoreRow()!;
    }
    await ensureRepo(row.storeId, STORE_NAME);
    await commitStore(row.storeId, STORE_NAME, storeContents(), "Update the store");
    const target = await storeUrl();
    if (!target) throw new AppError("store_address", "Gluon couldn't work out an address Umbrel can reach it at.", 500);
    const probe = await umbrelCanFetch(`${target.url}/info/refs?service=git-upload-pack`);
    return { address: hideToken(target.url), reachable: probe ? probe.ok : null, detail: probe && !probe.ok ? probe.detail : null, storeId: row.storeId };
  });
}

export async function setUpStore(user: User, where: Where): Promise<StoreStatus> {
  const prep = await prepareStore();
  if (prep.reachable === false) {
    const port = Number(process.env.PORT ?? 8130) || 8130;
    throw new AppError("store_unreachable", `Umbrel can't reach Gluon at ${prep.address.split("/api/")[0]}. Check that nothing blocks Umbrel's containers from reaching this server on port ${port}.`, 502, { detail: prep.detail });
  }
  return withStoreLock(async () => {
    const row = getStoreRow()!;
    const target = (await storeUrl())!;
    const regs = await registry();
    // An earlier address (Gluon moved ports, Umbrel's network changed): swap it for the new one.
    if (row.registeredUrl && row.registeredUrl !== target.url && regs.some((r) => r.url === row.registeredUrl)) await removeRepository(row.registeredUrl).catch(() => undefined);
    if (!regs.some((r) => r.url === target.url)) await addRepository(target.url);
    setStoreRegistered(target.url);
    audit(user, { action: "builder.store.register", target: row.storeId, summary: "Added Gluon's app store to Umbrel" }, where);
    return storeStatus();
  });
}

export async function removeStore(user: User, where: Where) {
  const row = getStoreRow();
  if (!row?.registeredUrl) return storeStatus();
  const ours = listAppRows().filter((a) => a.status === "published" && a.target === "umbrel");
  if (ours.length) throw conflict(`Remove ${ours.length === 1 ? ours[0]!.name : `the ${ours.length} apps you published`} from Umbrel first.`);
  await withStoreLock(async () => {
    const regs = await registry();
    if (regs.some((r) => r.url === row.registeredUrl)) await removeRepository(row.registeredUrl!);
    setStoreRegistered(null);
    // Umbrel keeps its clone of a removed store forever; take ours away so nothing is left behind.
    const ep = await findUmbrel();
    const folder = umbrelStoreFolder(row.registeredUrl!);
    if (ep && /^[a-z0-9][a-z0-9.-]{3,120}$/.test(folder) && folder.startsWith("api-appstore-")) {
      try {
        fs.rmSync(hostPath(`${ep.dataDir}/app-stores/${folder}`), { recursive: true, force: true });
      } catch {
        /* Umbrel ignores stray clones; not worth failing over */
      }
    }
  });
  audit(user, { action: "builder.store.unregister", target: row.storeId, summary: "Removed Gluon's app store from Umbrel" }, where);
  return storeStatus();
}

/**
 * Make Umbrel read the store now. Umbrel only re-reads stores every five minutes and has no call
 * to do it sooner, but adding a store clones it on the spot, so a refresh is remove + add. If the
 * add fails (Umbrel restarting), it's retried; the store's status then shows it needs repairing.
 */
async function refreshUmbrel(emit: Emit, expect?: { appId: string; version: string } | { appId: string; gone: true }) {
  const row = getStoreRow();
  const target = await storeUrl();
  if (!row || !target) throw new AppError("store_missing", "Set up Gluon's app store first.", 409);
  const regs = await registry();
  const listed = (rs: typeof regs) => {
    const ours = rs.find((r) => r.url === target.url);
    if (!ours || !expect) return !!ours;
    const app = ours.apps.find((a) => a.id === expect.appId);
    return "gone" in expect ? !app : app?.version === expect.version;
  };
  if (listed(regs) && expect) return;
  if (regs.some((r) => r.url === target.url)) await removeRepository(target.url);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await addRepository(target.url);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (e instanceof AppError && /already exists/i.test(e.message)) {
        lastError = null;
        break;
      }
      emit({ type: "line", text: `Umbrel couldn't read the store yet (${e instanceof Error ? e.message : "no answer"}). Trying again…`, stream: "err" });
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  if (lastError) throw new AppError("store_refresh", `Umbrel couldn't read Gluon's store: ${lastError instanceof Error ? lastError.message : "no answer"}. Open Your apps to repair the store, then publish again.`, 502);
  setStoreRegistered(target.url);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (listed(await registry().catch(() => []))) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new AppError("store_stale", "Umbrel read Gluon's store but doesn't list the new version yet. Try publishing again in a minute.", 502);
}

// ---------------------------------------------------------------- reading apps

async function runtimes(rows: AppRow[]): Promise<Map<string, RuntimeState>> {
  const out = new Map<string, RuntimeState>();
  const published = rows.filter((r) => r.status === "published" && r.appId);
  if (!published.length) return out;
  const [uApps, apps] = await Promise.all([
    published.some((r) => r.target === "umbrel") ? umbrelApps(5_000).catch(() => null) : Promise.resolve([]),
    listApps().catch(() => []),
  ]);
  const zoneUrl = (id: string) => {
    const a = apps.find((x) => x.id === id);
    return a ? (a.urls.home ?? a.urls.away) : null;
  };
  for (const r of published) {
    const inApps = apps.some((a) => a.id === r.appId);
    if (r.target === "umbrel") {
      if (uApps === null) {
        out.set(r.id, { target: "umbrel", state: "unknown", progress: 0, version: null, appsId: inApps ? r.appId : null, url: zoneUrl(r.appId!) });
        continue;
      }
      const u = uApps.find((a) => a.id === r.appId);
      out.set(r.id, { target: "umbrel", state: u?.state ?? "not-installed", progress: 0, version: u?.version ?? null, appsId: u || inApps ? r.appId : null, url: zoneUrl(r.appId!) });
    } else {
      const a = apps.find((x) => x.id === r.appId);
      out.set(r.id, { target: "compose", state: !a ? "not-installed" : a.line === "running" ? "running" : a.line === "stopped" ? "stopped" : a.line, progress: 0, version: r.publishedVersion, appsId: a ? a.id : null, url: a ? (a.urls.home ?? a.urls.away) : null });
    }
  }
  return out;
}

/** Which custom app a compose folder belongs to (its .gluon-app marker), if any. */
function folderOwner(dir: string): string | null {
  try {
    return fs.readFileSync(hostPath(`${dir}/.gluon-app`), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function firstImage(compose: string): string | null {
  const p = parseCompose(compose);
  if (!p.ok) return null;
  for (const n of serviceNames(p.doc)) {
    const img = readService(p.doc, n).image;
    if (img) return img;
  }
  return null;
}

const secretNames = (s: Secrets): SecretNames => Object.fromEntries(Object.entries(s.env).map(([svc, m]) => [svc, Object.keys(m)]).filter(([, k]) => (k as string[]).length));

function specChanged(a: AppSpec, b: AppSpec | null) {
  if (!b) return true;
  const strip = (s: AppSpec) => JSON.stringify({ ...s, details: { ...s.details, version: "", releaseNotes: "" } });
  return strip(a) !== strip(b);
}

export async function listCustomApps(): Promise<CustomAppListItem[]> {
  ensureSchema();
  const rows = listAppRows();
  const rt = await runtimes(rows);
  return rows.map((r) => {
    const job = currentJob(r.id);
    const b = r.github ? listBuilds(r.id)[0] : undefined;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      icon: r.spec.details.icon,
      tagline: r.spec.details.tagline,
      source: r.source,
      status: r.status,
      target: r.target,
      appId: r.appId,
      publishedVersion: r.publishedVersion,
      publishedAt: r.publishedAt,
      changed: r.status === "published" && specChanged(r.spec, r.publishedSpec),
      updatedAt: r.updatedAt,
      github: r.github ? { owner: r.github.owner, repo: r.github.repo, branch: r.github.branch, builtCommit: r.github.builtCommit, latestCommit: r.github.latestCommit } : null,
      runtime: rt.get(r.id) ?? null,
      image: firstImage(r.spec.compose),
      job: job && !job.finishedAt ? { kind: job.kind, startedAt: job.startedAt } : null,
      lastBuild: b ? { status: b.status, at: b.finishedAt ?? b.startedAt } : null,
    };
  });
}

export async function appDetail(id: string): Promise<CustomAppDetail> {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  const secrets = readSecrets(id);
  const rt = await runtimes([r]);
  const store = getStoreRow();
  const target = r.target ?? (await currentTarget());
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    target: r.target,
    appId: r.appId,
    spec: r.spec,
    secrets: secretNames(secrets),
    github: r.github ? { ...r.github, hasToken: !!secrets.githubToken } : null,
    rev: r.rev,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    publishedVersion: r.publishedVersion,
    publishedAt: r.publishedAt,
    publishedSpec: r.publishedSpec,
    versions: listVersions(id),
    builds: listBuilds(id),
    runtime: rt.get(id) ?? null,
    job: currentJob(id),
    nextVersion: nextVersion(r.spec.details.version, r.publishedVersion),
    lanHost: await lanHost().catch(() => null),
    plannedAppId: r.appId ?? (target === "umbrel" ? (store ? umbrelAppId(store.storeId, r.spec.details.slug) : null) : r.spec.details.slug),
  };
}

// ---------------------------------------------------------------- drafts

/** The web page's port, moved off ports something already uses (and off the privileged range). */
async function freeWebPort(spec: AppSpec, target: BuilderTarget): Promise<AppSpec> {
  const want = spec.web.port;
  if (!spec.web.service || !want) return spec;
  const check = await serverChecks(spec, target, null).catch(() => null);
  if (!check) return spec;
  const used = new Set(check.ports.filter((p) => p.proto === "tcp").map((p) => p.port));
  // Other services of this app publish ports too.
  const p = parseCompose(spec.compose);
  if (p.ok) for (const f of readServices(p.doc)) for (const port of f.ports) if (port.host && !(target === "umbrel" && port.host === want)) used.add(port.host);
  if (want >= 1024 && !used.has(want)) return spec;
  const start = want < 1024 ? 8080 : want + 1;
  for (let port = start; port < start + 500 && port < 65536; port++) if (!used.has(port)) return { ...spec, web: { ...spec.web, port } };
  return spec;
}

export async function createDraft(user: User, where: Where, input: { source: BuilderSource; spec: AppSpec; secrets?: Record<string, Record<string, string>>; github?: Omit<GithubSource, "hasToken"> | null; token?: string | null }): Promise<string> {
  ensureSchema();
  let slug = input.spec.details.slug;
  for (let n = 2; findBySlug(slug); n++) slug = `${input.spec.details.slug.slice(0, 27)}-${n}`;
  const spec = await freeWebPort({ ...input.spec, details: { ...input.spec.details, slug } }, await currentTarget());
  const secrets: Secrets = { env: input.secrets ?? {}, githubToken: input.token ?? undefined };
  const id = insertApp({ source: input.source, spec, github: input.github ?? null, secrets: Object.keys(secrets.env).length || secrets.githubToken ? secrets : null, userId: user.id });
  audit(user, { action: "builder.create", target: id, summary: `Started a new app, ${spec.details.name}` }, where);
  return id;
}

export interface DraftPatch {
  rev: number;
  spec: AppSpec;
  secrets?: { set?: Record<string, Record<string, string>>; remove?: Record<string, string[]>; renameService?: { from: string; to: string } };
  github?: { branch: string; path: string };
  token?: string | null;
}

export function saveDraft(id: string, patch: DraftPatch): { rev: number; updatedAt: number } {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  if (patch.rev !== r.rev) throw new AppError("stale", "This app was changed somewhere else (another tab, or a publish). Reload to see the latest before editing.", 409);
  const spec: AppSpec = r.status === "published" ? { ...patch.spec, details: { ...patch.spec.details, slug: r.slug } } : patch.spec;
  if (r.status !== "published" && spec.details.slug !== r.slug && findBySlug(spec.details.slug, id)) {
    throw new AppError("invalid", `Another app already uses the id “${spec.details.slug}”.`, 400, { field: "details.slug" });
  }
  if (patch.secrets || patch.token !== undefined) {
    const s = readSecrets(id);
    const ops = patch.secrets ?? {};
    if (ops.renameService && s.env[ops.renameService.from]) {
      s.env[ops.renameService.to] = { ...(s.env[ops.renameService.to] ?? {}), ...s.env[ops.renameService.from] };
      delete s.env[ops.renameService.from];
    }
    for (const [svc, kv] of Object.entries(ops.set ?? {})) s.env[svc] = { ...(s.env[svc] ?? {}), ...kv };
    for (const [svc, keys] of Object.entries(ops.remove ?? {})) {
      for (const k of keys) delete s.env[svc]?.[k];
      if (s.env[svc] && !Object.keys(s.env[svc]!).length) delete s.env[svc];
    }
    if (patch.token !== undefined) s.githubToken = patch.token || undefined;
    writeSecrets(id, s);
  }
  let github: AppRow["github"] | undefined;
  if (patch.github && r.github) github = { ...r.github, branch: patch.github.branch, path: patch.github.path };
  const saved = saveSpec(id, spec, { github });
  publishEvent("builder.changed", { id });
  return { rev: saved.rev, updatedAt: saved.updated_at };
}

export function deleteDraft(user: User, where: Where, id: string) {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  if (r.status === "published") throw conflict(`${r.name} is published. Remove it first.`);
  if (isRunning(id)) throw conflict("Wait for the current operation to finish.");
  deleteApp(id);
  void pruneImages(id, []);
  audit(user, { action: "builder.delete", target: id, summary: `Deleted the draft app ${r.name}` }, where);
}

/** The latest commit on the app's branch, saved for the list's "new commits" note. */
export async function checkCommits(id: string): Promise<{ latest: string; built: string | null }> {
  const r = getAppRow(id);
  if (!r?.github) throw notFound("That app's repository");
  const latest = await latestCommit(r.github, readSecrets(id).githubToken);
  saveGithub(id, { ...r.github, latestCommit: latest, checkedAt: Date.now() });
  return { latest, built: r.github.builtCommit };
}

// ---------------------------------------------------------------- checks

export async function checkApp(id: string, opts: { images?: boolean } = {}) {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  const target = r.target ?? (await currentTarget());
  const ownId = r.appId ?? null;
  const res = await serverChecks(r.spec, target, ownId, opts);
  const dup = r.status !== "published" ? findBySlug(r.spec.details.slug, id) : null;
  if (dup) res.issues.push({ id: "srv-slug", level: "error", message: `Another app you made (${dup.name}) already uses the id “${r.spec.details.slug}”.`, field: "details.slug" });
  const folder = await folderFor(r.spec.details.slug, id);
  if (target === "compose" && r.status !== "published" && hostExists(folder) && folderOwner(folder) !== id) {
    res.issues.push({ id: "srv-folder", level: "error", message: `${folder} already exists and isn't this app's. Pick another id.`, field: "details.slug" });
  } else if (target === "compose" && r.status !== "published" && hostExists(folder)) {
    res.issues.push({ id: "srv-folder-kept", level: "info", message: `Its data from before is still in ${folder}; publishing picks it back up.` });
  }
  const secrets = readSecrets(id);
  for (const [svc, kv] of Object.entries(secrets.env)) for (const [k, v] of Object.entries(kv)) if (!v) res.issues.push({ id: `srv-secret-empty-${svc}-${k}`, level: "warning", message: `The secret ${k} of “${svc}” is empty.`, field: `services.${svc}.env` });
  return res;
}

function localIssues(r: AppRow, target: BuilderTarget, secrets: Secrets): Issue[] {
  const a = analyze(r.spec.compose, { source: r.source, target, web: r.spec.web, secrets: secretNames(secrets) });
  return [...detailIssues(r.spec, r.status === "published"), ...a.issues];
}

class Failed extends AppError {
  constructor(message: string, lines: string[]) {
    super("publish_failed", message, 400, { lines });
  }
}

// ---------------------------------------------------------------- publishing

const UMBREL_STAGES = (build: boolean, update: boolean) => [
  { key: "check", label: "Check" },
  ...(build ? [{ key: "build", label: "Build" }] : []),
  { key: "store", label: "Add to the store" },
  { key: "umbrel", label: update ? "Update in Umbrel" : "Install in Umbrel" },
  { key: "run", label: "Running" },
];
const COMPOSE_STAGES = (build: boolean) => [{ key: "check", label: "Check" }, ...(build ? [{ key: "build", label: "Build" }] : []), { key: "write", label: "Write files" }, { key: "start", label: "Start" }, { key: "run", label: "Running" }];

export async function startPublish(id: string, user: User, where: Where, opts: { rebuild?: boolean } = {}) {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  const target = r.target ?? (await currentTarget());
  if (r.target === "umbrel" && (await activePlatform().catch(() => "none" as const)) !== "umbrel") {
    throw new AppError("target_changed", `${r.name} was published to Umbrel, but Gluon isn't working with Umbrel now.`, 409);
  }
  const building = buildServices(r.spec.compose).length > 0 && r.source === "github";
  const installed = target === "umbrel" && r.appId ? (await umbrelApps(0).catch(() => [])).some((a) => a.id === r.appId) : r.status === "published";
  const stages = target === "umbrel" ? UMBREL_STAGES(building, installed) : COMPOSE_STAGES(building);
  startJob(id, "publish", stages, (emit) => (target === "umbrel" ? publishUmbrel(id, user, where, emit, opts) : publishCompose(id, user, where, emit, opts)));
}

async function validate(r: AppRow, target: BuilderTarget, ownId: string | null, emit: Emit) {
  emit({ type: "stage", stage: "check" });
  emit({ type: "step", text: "Checking the app" });
  const secrets = readSecrets(r.id);
  const issues = localIssues(r, target, secrets);
  const server = await serverChecks(r.spec, target, ownId, { images: true });
  const errors = [...issues, ...server.issues].filter((i) => i.level === "error");
  if (errors.length) throw new Failed(errors.length === 1 ? errors[0]!.message : `${errors.length} problems need fixing before this can be published.`, errors.map((e) => e.message));
  return secrets;
}

async function buildIfNeeded(r: AppRow, user: User, emit: Emit, rebuild: boolean): Promise<{ images: Record<string, string>; commit: string | null }> {
  const services = buildServices(r.spec.compose);
  if (!services.length || r.source !== "github" || !r.github) return { images: {}, commit: null };
  const good = lastGoodBuild(r.id);
  const wanted = services.map((s) => s.service).sort().join(",");
  if (!rebuild && good && good.commit === r.github.builtCommit && Object.keys(good.images).sort().join(",") === wanted && (await imagesPresent(good.images))) {
    emit({ type: "step", text: `Using the images built from ${good.commit.slice(0, 7)}` });
    return { images: good.images, commit: good.commit };
  }
  emit({ type: "stage", stage: "build" });
  const res = await buildApp(r, readSecrets(r.id).githubToken, { id: user.id, username: user.username }, (text, stream) => emit({ type: "line", text, stream }), (text) => emit({ type: "step", text }));
  saveGithub(r.id, { ...r.github, builtCommit: res.commit, builtAt: Date.now(), latestCommit: res.commit, checkedAt: Date.now() });
  return res;
}

function writeSecretFiles(dir: string, secrets: Secrets, services: string[]) {
  const secretsDir = `${dir}/secrets`;
  const want = services.filter((s) => Object.keys(secrets.env[s] ?? {}).length);
  if (want.length) fs.mkdirSync(hostPath(secretsDir), { recursive: true, mode: 0o700 });
  for (const s of want) {
    const file = hostPath(`${secretsDir}/${s}.env`);
    fs.writeFileSync(`${file}.tmp`, envFile(secrets.env[s]!), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  // Services that no longer have secrets lose their file.
  if (hostExists(secretsDir)) {
    for (const f of fs.readdirSync(hostPath(secretsDir))) if (f.endsWith(".env") && !want.includes(f.slice(0, -4))) fs.rmSync(hostPath(`${secretsDir}/${f}`), { force: true });
  }
}

async function publishUmbrel(id: string, user: User, where: Where, emit: Emit, opts: { rebuild?: boolean }) {
  let r = getAppRow(id)!;
  const store = getStoreRow();
  if (!store?.registeredUrl) throw new AppError("store_missing", "Set up Gluon's app store in Umbrel first.", 409);
  const ep = await findUmbrel();
  if (!ep) throw new AppError("umbrel_missing", "Gluon can't find Umbrel on this server.", 503);
  const appId = r.appId ?? umbrelAppId(store.storeId, r.spec.details.slug);
  const secrets = await validate(r, "umbrel", r.appId, emit);
  const built = await buildIfNeeded(r, user, emit, !!opts.rebuild);
  r = getAppRow(id)!;
  const version = nextVersion(r.spec.details.version, r.publishedVersion);
  const services = analyze(r.spec.compose, { source: r.source, target: "umbrel", web: r.spec.web, secrets: secretNames(secrets) }).services.map((s) => s.name);
  const rendered = renderApp({ spec: r.spec, target: "umbrel", appId, version, secrets: secretNames(secrets), images: built.images, gluonUrl: gluonUrl(id), repoUrl: repoUrl(r.github) });

  emit({ type: "stage", stage: "store" });
  emit({ type: "step", text: `Adding version ${version} to Gluon's store` });
  // Secrets go next to the app on the server, never into the store's history.
  writeSecretFiles(`${ep.dataDir}/app-data/${appId}`, secrets, services);
  const revision = r.publishedRevision + 1;
  const publishedSpec: AppSpec = { ...r.spec, details: { ...r.spec.details, version } };
  let storeCommit: string | null = null;
  await withStoreLock(async () => {
    storeCommit = await commitStore(store.storeId, STORE_NAME, storeContents({ appId, files: rendered.files }), `${r.status === "published" ? "Update" : "Add"} ${r.spec.details.name} ${version}`);
    addVersion(id, { revision, version, files: rendered.files, storeCommit, sourceCommit: built.commit, images: built.images, userId: user.id, username: user.username });
    markPublished(id, { target: "umbrel", appId, version, spec: publishedSpec, revision });
    emit({ type: "step", text: "Asking Umbrel to read the store" });
    await refreshUmbrel(emit, { appId, version });
  });

  emit({ type: "stage", stage: "umbrel" });
  const installed = (await umbrelApps(0)).find((a) => a.id === appId);
  if (installed?.version === version) {
    emit({ type: "stage", stage: "run" });
    return { ok: true, message: `Umbrel already runs ${version}.` };
  }
  const action = installed ? "update" : "install";
  emit({ type: "step", text: installed ? `Updating ${r.spec.details.name} in Umbrel` : `Installing ${r.spec.details.name} in Umbrel` });
  const started = Date.now();
  const running = startAction(appId, action);
  const words: Partial<Record<UmbrelAppState, string>> = { installing: "Installing", updating: "Updating", starting: "Starting", ready: "Running", running: "Running", stopped: "Stopped", "not-installed": "Not installed", restarting: "Restarting" };
  let lastWord = "";
  const end = await followState(
    appId,
    (s, seen) => ((s === "ready" || s === "running") && (seen.has(action === "install" ? "installing" : "updating") || action === "update")) || (s === "not-installed" && seen.has("installing")),
    (s, progress) => {
      const w = words[s] ?? s;
      if (w !== lastWord) emit({ type: "line", text: w });
      lastWord = w;
      if ((s === "installing" || s === "updating") && progress > 0 && progress < 100) emit({ type: "progress", done: Math.round(progress), total: 100, current: `Downloading · ${Math.round(progress)}%` });
    },
    { action: running },
  );
  const result = await Promise.race([running, new Promise<{ ok: boolean; error: string | null }>((res) => setTimeout(() => res({ ok: true, error: null }), 5000))]);
  const ok = result.ok && (end === "ready" || end === "running");
  audit(user, { action: action === "install" ? "builder.install" : "builder.update", target: appId, summary: ok ? `${action === "install" ? "Installed" : "Updated"} ${r.spec.details.name} ${version} in Umbrel` : `Tried to ${action} ${r.spec.details.name} ${version} in Umbrel`, outcome: ok ? "ok" : "failed" }, where);
  invalidateApps();
  if (ok) {
    emit({ type: "stage", stage: "run" });
    if (built.commit) void pruneImages(id, [...Object.values(built.images), ...Object.values(previousImages(id))]);
    const url = await appUrl(r.spec, appId);
    return { ok: true, message: `${r.spec.details.name} ${version} is ${action === "install" ? "installed" : "updated"} and running${url ? ` at ${url}` : ""}.` };
  }
  const log = await umbrelLog(appId, started);
  const why = result.error ?? (end === "not-installed" ? "Umbrel stopped the install." : end === "stopped" ? "The app stopped right after starting." : end === "installing" || end === "updating" ? "Umbrel is still working on it." : `Umbrel says it's ${end}.`);
  if (end === "installing" || end === "updating") {
    return { ok: false, message: `Umbrel has been ${end} ${r.spec.details.name} for a long time. It may still finish; check Apps in a few minutes.`, detail: log };
  }
  throw new Failed(`${r.spec.details.name} ${version} is in the store, but Umbrel couldn't ${action} it. ${why}`, log.length ? log : [why]);
}


async function appUrl(spec: AppSpec, _appId: string): Promise<string | null> {
  if (!spec.web.service || !spec.web.port) return null;
  const host = await lanHost().catch(() => null);
  return host ? `http://${host}:${spec.web.port}${spec.web.path || ""}` : null;
}

function composeLines(dir: string, project: string, args: string[], emit: Emit): Promise<number> {
  return new Promise((resolve) => {
    const child = hostSpawn("docker", ["compose", "-p", project, "--project-directory", dir, "-f", `${dir}/docker-compose.yml`, ...args]);
    const out = lineReader((l) => emit({ type: "line", text: l }));
    const err = lineReader((l) => emit({ type: "line", text: l }));
    child.stdout?.on("data", (d) => out.push(d));
    child.stderr?.on("data", (d) => err.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.flush();
      err.flush();
      resolve(code ?? 1);
    });
    child.on("error", () => resolve(1));
  });
}

async function publishCompose(id: string, user: User, where: Where, emit: Emit, opts: { rebuild?: boolean }) {
  let r = getAppRow(id)!;
  const project = r.appId ?? r.spec.details.slug;
  const secrets = await validate(r, "compose", r.appId, emit);
  const built = await buildIfNeeded(r, user, emit, !!opts.rebuild);
  r = getAppRow(id)!;
  const dir = await folderFor(project, id);
  const owner = folderOwner(dir);
  if (hostExists(dir) && owner !== id) {
    throw new AppError("folder_taken", owner ? `${dir} holds the data of another app you made (or one Gluon forgot). Delete the folder, or give this app another id.` : `${dir} already exists and isn't one of Gluon's apps. Pick another id.`, 409);
  }
  const version = nextVersion(r.spec.details.version, r.publishedVersion);
  const services = analyze(r.spec.compose, { source: r.source, target: "compose", web: r.spec.web, secrets: secretNames(secrets) }).services.map((s) => s.name);
  const rendered = renderApp({ spec: r.spec, target: "compose", appId: project, version, secrets: secretNames(secrets), images: built.images, gluonUrl: gluonUrl(id), repoUrl: repoUrl(r.github), appDir: dir });

  emit({ type: "stage", stage: "write" });
  emit({ type: "step", text: `Writing ${dir}` });
  fs.mkdirSync(hostPath(dir), { recursive: true, mode: 0o755 });
  fs.writeFileSync(hostPath(`${dir}/.gluon-app`), `${id}\n`);
  invalidateAppsRoot();
  for (const [rel, content] of Object.entries(rendered.files)) {
    const file = hostPath(`${dir}/${rel}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, content, { mode: rel === ".env" ? 0o600 : 0o644 });
    fs.renameSync(`${file}.tmp`, file);
  }
  // Data folders belong to uid 1000 like Umbrel's, so images that don't run as root can write.
  for (const f of rendered.dataFolders) {
    const p = hostPath(`${dir}/data/${f}`);
    if (fs.existsSync(p)) continue;
    fs.mkdirSync(p, { recursive: true });
    try {
      fs.chownSync(p, 1000, 1000);
      fs.chownSync(hostPath(`${dir}/data`), 1000, 1000);
    } catch {
      /* not root in development */
    }
  }
  writeSecretFiles(dir, secrets, services);
  const revision = r.publishedRevision + 1;
  const publishedSpec: AppSpec = { ...r.spec, details: { ...r.spec.details, version } };
  addVersion(id, { revision, version, files: rendered.files, storeCommit: null, sourceCommit: built.commit, images: built.images, userId: user.id, username: user.username });
  markPublished(id, { target: "compose", appId: project, version, spec: publishedSpec, revision });

  // How the Apps page shows it: the builder's name, tagline and icon.
  setAppPrefs(project, { display_name: r.spec.details.name.trim(), description: r.spec.details.tagline.trim() || null, icon: r.spec.details.icon });

  emit({ type: "stage", stage: "start" });
  emit({ type: "step", text: "Downloading images" });
  await composeLines(dir, project, ["pull", "--ignore-pull-failures", "--quiet"], emit);
  emit({ type: "step", text: "Starting with docker compose up" });
  const code = await composeLines(dir, project, ["up", "-d", "--remove-orphans"], emit);
  invalidateApps();
  audit(user, { action: "builder.deploy", target: project, summary: code === 0 ? `Started ${r.spec.details.name} ${version} with Docker Compose` : `Tried to start ${r.spec.details.name} ${version}`, outcome: code === 0 ? "ok" : "failed" }, where);
  if (code !== 0) throw new Failed(`${r.spec.details.name} ${version} didn't start. The output above shows why; fix the app and publish again.`, []);
  emit({ type: "stage", stage: "run" });
  if (built.commit) void pruneImages(id, [...Object.values(built.images), ...Object.values(previousImages(id))]);
  const url = await appUrl(r.spec, project);
  return { ok: true, message: `${r.spec.details.name} ${version} is running${url ? ` at ${url}` : ""}.` };
}

// ---------------------------------------------------------------- building on its own

export function startBuild(id: string, user: User, where: Where) {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  if (!r.github) throw new AppError("no_repo", "Only apps from a repository are built.", 400);
  startJob(id, "build", [{ key: "build", label: "Build" }, { key: "run", label: "Built" }], async (emit) => {
    emit({ type: "stage", stage: "build" });
    const res = await buildApp(r, readSecrets(id).githubToken, { id: user.id, username: user.username }, (text, stream) => emit({ type: "line", text, stream }), (text) => emit({ type: "step", text }));
    saveGithub(id, { ...r.github!, builtCommit: res.commit, builtAt: Date.now(), latestCommit: res.commit, checkedAt: Date.now() });
    audit(user, { action: "builder.build", target: id, summary: `Built ${r.name} from ${r.github!.owner}/${r.github!.repo} ${res.commit.slice(0, 7)}` }, where);
    emit({ type: "stage", stage: "run" });
    return { ok: true, message: `Built ${res.commit.slice(0, 7)}. Publish to run it${r.status === "published" ? " in place of the current version" : ""}.` };
  });
}

// ---------------------------------------------------------------- removing

export async function startRemove(id: string, user: User, where: Where, opts: { keepData: boolean; forget: boolean }) {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  if (r.status !== "published" || !r.appId) {
    if (opts.forget) return deleteDraft(user, where, id);
    throw conflict(`${r.name} isn't published.`);
  }
  const stages = r.target === "umbrel" ? [{ key: "stop", label: "Stop" }, { key: "umbrel", label: "Uninstall" }, { key: "store", label: "Remove from the store" }] : [{ key: "stop", label: "Stop" }, { key: "files", label: opts.keepData ? "Keep data" : "Delete files" }];
  startJob(id, "remove", stages, async (emit) => (r.target === "umbrel" ? removeUmbrel(r, user, where, emit, opts) : removeCompose(r, user, where, emit, opts)));
}

async function removeUmbrel(r: AppRow, user: User, where: Where, emit: Emit, opts: { keepData: boolean; forget: boolean }) {
  const appId = r.appId!;
  const ep = await findUmbrel();
  if (!ep) throw new AppError("umbrel_missing", "Gluon can't find Umbrel on this server.", 503);
  const installed = (await umbrelApps(0)).find((a) => a.id === appId);
  let kept: string | null = null;
  if (installed) {
    emit({ type: "stage", stage: "stop" });
    if (opts.keepData && hostExists(`${ep.dataDir}/app-data/${appId}/data`)) {
      emit({ type: "step", text: `Stopping ${r.name}` });
      const stop = await startAction(appId, "stop");
      if (!stop.ok) throw new AppError("umbrel_stop", `Umbrel couldn't stop ${r.name}: ${stop.error ?? "no reason given"}. Nothing was removed.`, 502);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      kept = `${ep.dataDir}/home/Gluon kept data/${r.slug}-${stamp}`;
      emit({ type: "step", text: `Keeping its data in ${kept.replace(`${ep.dataDir}/home`, "Home")}` });
      const keptRoot = hostPath(path.posix.dirname(kept));
      if (!fs.existsSync(keptRoot)) {
        fs.mkdirSync(keptRoot, { recursive: true });
        try {
          fs.chownSync(keptRoot, 1000, 1000); // Umbrel's Files app owns Home as uid 1000
        } catch {
          /* fine */
        }
      }
      fs.renameSync(hostPath(`${ep.dataDir}/app-data/${appId}/data`), hostPath(kept));
    }
    emit({ type: "stage", stage: "umbrel" });
    emit({ type: "step", text: `Uninstalling ${r.name} in Umbrel` });
    const run = startAction(appId, "uninstall");
    const said = new Set<string>();
    const end = await followState(
      appId,
      (s) => s === "not-installed",
      (s) => {
        // Before Umbrel picks the request up it still reports the app as it was; only report the uninstall itself.
        const w = s === "uninstalling" || s === "stopping" ? "Uninstalling" : s === "not-installed" ? "Uninstalled" : null;
        if (w && !said.has(w)) {
          said.add(w);
          emit({ type: "line", text: w });
        }
      },
      { action: run, timeoutMs: 15 * 60_000 },
    );
    const res = await Promise.race([run, new Promise<{ ok: boolean; error: string | null }>((res) => setTimeout(() => res({ ok: end === "not-installed", error: null }), 3000))]);
    if (end !== "not-installed") {
      throw new AppError("umbrel_uninstall", `Umbrel couldn't uninstall ${r.name}${res.error ? `: ${res.error}` : ""}.${kept ? ` Its data was already moved to ${kept}.` : ""}`, 502);
    }
  }
  emit({ type: "stage", stage: "store" });
  emit({ type: "step", text: "Removing it from Gluon's store" });
  const store = getStoreRow();
  if (store?.registeredUrl) {
    await withStoreLock(async () => {
      await commitStore(store.storeId, STORE_NAME, storeContents(undefined, appId), `Remove ${r.name}`);
      await refreshUmbrel(emit, { appId, gone: true }).catch((e) => emit({ type: "line", text: `Umbrel will drop it from the store within five minutes (${e instanceof Error ? e.message : "no answer"}).`, stream: "err" }));
    });
  }
  const secretsDir = `${ep.dataDir}/app-data/${appId}`;
  if (!installed && hostExists(`${secretsDir}/secrets`) && !hostExists(`${secretsDir}/umbrel-app.yml`)) fs.rmSync(hostPath(secretsDir), { recursive: true, force: true });
  finishRemoval(r, user, where, opts, kept);
  return { ok: true, message: `${r.name} is removed from Umbrel.${kept ? ` Its data is in Umbrel's Files under Home › Gluon kept data.` : ""}` };
}

async function removeCompose(r: AppRow, user: User, where: Where, emit: Emit, opts: { keepData: boolean; forget: boolean }) {
  const dir = await folderFor(r.appId!, r.id);
  emit({ type: "stage", stage: "stop" });
  if (hostExists(`${dir}/docker-compose.yml`)) {
    emit({ type: "step", text: `Stopping and removing ${r.name}'s containers` });
    const code = await composeLines(dir, r.appId!, ["down", "--remove-orphans"], emit);
    if (code !== 0) throw new AppError("compose_down", `docker compose couldn't remove ${r.name}. Nothing was deleted.`, 500);
  }
  emit({ type: "stage", stage: "files" });
  // Only ever delete a folder this app's marker says is its own.
  if (!opts.keepData && folderOwner(dir) === r.id) {
    emit({ type: "step", text: `Deleting ${dir}` });
    fs.rmSync(hostPath(dir), { recursive: true, force: true });
  } else if (hostExists(dir)) {
    // The marker stays: publishing this app again picks its data back up.
    emit({ type: "step", text: `Keeping ${dir}` });
  }
  invalidateApps();
  finishRemoval(r, user, where, opts, opts.keepData ? dir : null);
  return { ok: true, message: `${r.name} is removed.${opts.keepData ? ` Its files are still in ${dir}.` : ""}` };
}

function finishRemoval(r: AppRow, user: User, where: Where, opts: { forget: boolean }, kept: string | null) {
  audit(user, { action: "builder.remove", target: r.appId, summary: `Removed ${r.name}${kept ? ", keeping its data" : ""}`, detail: kept ? { kept } : undefined }, where);
  if (opts.forget) {
    deleteApp(r.id);
    void pruneImages(r.id, []);
  } else markUnpublished(r.id);
  invalidateApps();
}

export { headCommit };

// ---------------------------------------------------------------- preview

/** Exactly what the next publish would write (secrets never included), for the Files tab. */
export async function previewFiles(id: string): Promise<{ target: BuilderTarget; appId: string; version: string; files: Record<string, string>; published: Record<string, string> | null; error: string | null; secretFiles: string[] }> {
  const r = getAppRow(id);
  if (!r) throw notFound("That app");
  const target = r.target ?? (await currentTarget());
  const store = getStoreRow();
  const appId = r.appId ?? (target === "umbrel" ? umbrelAppId(store?.storeId ?? "gluon", r.spec.details.slug) : r.spec.details.slug);
  const version = nextVersion(r.spec.details.version, r.publishedVersion);
  const secrets = secretNames(readSecrets(id));
  const last = latestVersionFiles(id);
  const images: Record<string, string> = {};
  for (const s of buildServices(r.spec.compose)) images[s.service] = last?.images[s.service] ?? `gluon.local/${r.slug}${s.service === r.slug ? "" : `-${s.service}`}:<commit>`;
  try {
    const rendered = renderApp({ spec: r.spec, target, appId, version, secrets, images, gluonUrl: gluonUrl(id), repoUrl: repoUrl(r.github), appDir: await folderFor(appId, id) });
    return { target, appId, version, files: rendered.files, published: last?.files ?? null, error: null, secretFiles: Object.keys(secrets).map((s) => `secrets/${s}.env`) };
  } catch (e) {
    return { target, appId, version, files: {}, published: last?.files ?? null, error: e instanceof Error ? e.message : "The compose file has errors.", secretFiles: [] };
  }
}
