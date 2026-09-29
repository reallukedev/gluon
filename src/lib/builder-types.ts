/**
 * Types shared by the app builder's server code and its screens (no server imports).
 *
 * A custom app is a compose file plus the details Umbrel shows (name, icon, description…). The
 * compose text is the source of truth; the form edits it in place. Secret environment values never
 * live in the compose text: they are kept encrypted and written to an env file next to the app when
 * it is published, so they never enter the app store's git history.
 */

export type BuilderSource = "image" | "compose" | "github";
/** Where a published app runs: through Umbrel's app store, or as a compose project Gluon runs itself. */
export type BuilderTarget = "umbrel" | "compose";

export interface AppDetails {
  name: string;
  /** Lowercase id part, e.g. "paperless". Fixed once the app is published. */
  slug: string;
  tagline: string;
  description: string;
  category: string;
  /** https URL or a data: URI (png, jpeg, webp, svg). */
  icon: string | null;
  website: string;
  support: string;
  developer: string;
  /** What the person calls this version ("1.4.2"). Gluon adds a suffix when a republish reuses it. */
  version: string;
  releaseNotes: string;
}

export interface WebSettings {
  /** The service that serves the web page, or null when the app has none. */
  service: string | null;
  /** The port the web page listens on inside that container. */
  containerPort: number | null;
  /** The port on this server that opens the app (Umbrel's tile, Gluon's link). */
  port: number | null;
  /** A path to open, e.g. "/admin". */
  path: string;
  /** Umbrel: ask for the Umbrel password before the app opens (its app proxy). */
  umbrelAuth: boolean;
}

export interface GithubSource {
  owner: string;
  repo: string;
  branch: string;
  /** Folder inside the repository the app lives in ("" for the root). */
  path: string;
  private: boolean;
  /** A token is stored (encrypted). Its value never leaves the server. */
  hasToken: boolean;
  /** Commit the current images were built from. */
  builtCommit: string | null;
  builtAt: number | null;
  /** Newest commit on the branch the last time Gluon looked. */
  latestCommit: string | null;
  checkedAt: number | null;
}

export interface AppSpec {
  details: AppDetails;
  web: WebSettings;
  /** The compose file as the person edits it (secrets excluded, app data under ${APP_DATA_DIR}). */
  compose: string;
}

/** Secret environment variables per service: names only on the client, values stay on the server. */
export type SecretNames = Record<string, string[]>;

export type IssueLevel = "error" | "warning" | "info";

export interface Issue {
  id: string;
  level: IssueLevel;
  message: string;
  /** Where it belongs in the form, e.g. "details.name", "services.web.image", "services.web.ports.1". */
  field?: string;
  /** 1-based line in the compose text, when it points at one. */
  line?: number;
  /** A fix Gluon can make, applied with applyFix(). */
  fix?: { id: string; label: string };
}

export type CustomAppStatus = "draft" | "published";

/** How the app is doing where it runs (Umbrel state, or the compose stack's state). */
export interface RuntimeState {
  target: BuilderTarget;
  /** Umbrel's state words, or "running" | "stopped" | "not-installed" for compose. */
  state: string;
  progress: number;
  /** Version the platform runs, when it says. */
  version: string | null;
  /** Gluon's app id for /apps/<id>, when it's on the Apps page. */
  appsId: string | null;
  url: string | null;
}

export interface JobEvent {
  type: "step" | "line" | "progress" | "done" | "error" | "stage" | "plan";
  /** For "plan": the job's FlowSteps stages (sent first on every stream). */
  stages?: { key: string; label: string }[];
  kind?: JobKind;
  text?: string;
  stream?: "out" | "err";
  id?: string;
  state?: "running" | "done" | "failed";
  done?: number;
  total?: number;
  current?: string;
  ok?: boolean;
  message?: string;
  /** For "stage": which FlowSteps stage is now current. */
  stage?: string;
  /** For "done": extra lines (Umbrel's log) worth showing under the result. */
  detail?: string[];
}

export type JobKind = "publish" | "build" | "remove";

export interface JobSnapshot {
  kind: JobKind;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  events: JobEvent[];
  /** The FlowSteps plan for this job. */
  stages: { key: string; label: string }[];
}

export interface CustomAppListItem {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  tagline: string;
  source: BuilderSource;
  status: CustomAppStatus;
  target: BuilderTarget | null;
  /** Platform app id (Umbrel app id or compose project) once published. */
  appId: string | null;
  publishedVersion: string | null;
  publishedAt: number | null;
  /** The draft differs from what was published. */
  changed: boolean;
  updatedAt: number;
  github: Pick<GithubSource, "owner" | "repo" | "branch" | "builtCommit" | "latestCommit"> | null;
  runtime: RuntimeState | null;
  /** The first service's image, to tell image apps apart in the list. */
  image: string | null;
  job: { kind: JobKind; startedAt: number } | null;
  lastBuild: { status: BuildStatus; at: number } | null;
}

export type BuildStatus = "running" | "ok" | "failed";

export interface BuildSummary {
  id: string;
  status: BuildStatus;
  commit: string | null;
  images: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  username: string | null;
}

export interface PublishedVersion {
  revision: number;
  version: string;
  publishedAt: number;
  username: string | null;
  storeCommit: string | null;
  sourceCommit: string | null;
}

export interface CustomAppDetail {
  id: string;
  source: BuilderSource;
  status: CustomAppStatus;
  target: BuilderTarget | null;
  appId: string | null;
  spec: AppSpec;
  secrets: SecretNames;
  github: GithubSource | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
  publishedVersion: string | null;
  publishedAt: number | null;
  /** The spec as last published, to show what changed. */
  publishedSpec: AppSpec | null;
  versions: PublishedVersion[];
  builds: BuildSummary[];
  runtime: RuntimeState | null;
  job: JobSnapshot | null;
  /** What the next publish will be called. */
  nextVersion: string;
  /** This server's address on the LAN, for links to the app's port. */
  lanHost: string | null;
  /** Umbrel app id this draft will get (store id + slug). */
  plannedAppId: string | null;
}

export interface StoreStatus {
  platform: "umbrel" | "casaos" | "none";
  /** Umbrel reachable right now. */
  umbrel: "ok" | "unreachable" | "missing";
  /** Gluon's store exists and Umbrel lists it. */
  registered: boolean;
  /** Registered once, but Umbrel no longer lists it (removed by hand, or Umbrel was reset). */
  lost: boolean;
  storeId: string | null;
  /** The address Umbrel reads the store from, with the secret part hidden. */
  displayUrl: string | null;
  /** git is missing in Gluon's image. */
  gitMissing: boolean;
  /** Where compose apps go when Umbrel isn't used. */
  composeRoot: string;
}

export interface CustomAppsResponse {
  store: StoreStatus;
  apps: CustomAppListItem[];
}

/** POST /api/custom-apps/github/inspect */
export interface RepoInspection {
  owner: string;
  repo: string;
  branch: string;
  defaultBranch: string;
  path: string;
  private: boolean;
  commit: string;
  htmlUrl: string;
  found: { manifest: string | null; compose: string | null; dockerfile: string | null };
  /** What Gluon will make of it, in words. */
  plan: string;
  prefill: { details: Partial<AppDetails>; web: Partial<WebSettings>; compose: string };
  notes: string[];
}

/** GET /api/custom-apps/image */
export interface ImageLookup {
  ref: string;
  exists: boolean | null;
  local: boolean;
  /** When we couldn't ask the registry (offline, rate limited). */
  unknownReason: string | null;
  tags: string[];
  ports: { port: number; proto: "tcp" | "udp" }[];
  volumes: string[];
  env: { key: string; value: string }[];
  user: string | null;
  description: string | null;
}

export interface ServerCheck {
  issues: Issue[];
  /** Host ports in use (TCP/UDP) and who uses them, for the port fields. */
  ports: { port: number; proto: "tcp" | "udp"; by: string }[];
}

export const CATEGORIES: { value: string; label: string }[] = [
  { value: "files", label: "Files & productivity" },
  { value: "media", label: "Media" },
  { value: "networking", label: "Networking" },
  { value: "automation", label: "Home & automation" },
  { value: "developer", label: "Developer tools" },
  { value: "social", label: "Social" },
  { value: "finance", label: "Finance" },
  { value: "gaming", label: "Gaming" },
  { value: "ai", label: "AI" },
  { value: "other", label: "Other" },
];
