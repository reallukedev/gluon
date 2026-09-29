/** Settings → Updates: what's running, what's available, and how Gluon can update itself. */

/** Stable: tagged GitHub releases. Nightly: every commit pushed to main. */
export type UpdateChannel = "stable" | "nightly";
export type UpdateMethod = "github" | "umbrel" | "casaos";
/** Nightly automatic updates: install each one soon after it lands, or once a day in the chosen hour. */
export type NightlyTiming = "asap" | "hour";

export const CHANNEL_NAME: Record<UpdateChannel, string> = { stable: "Stable", nightly: "Nightly" };

/** Older copies stored "releases" / "main"; read those as the channels they meant. */
export function normalizeChannel(v: unknown): unknown {
  return v === "releases" ? "stable" : v === "main" ? "nightly" : v;
}

/** A nightly build's name: "1.3.0-nightly.20260928.1a2b3c4" (older copies: "main-1a2b3c4"). */
export function isNightlyVersion(v: string): boolean {
  return /-nightly\./.test(v) || /^main-[0-9a-f]{7,}$/.test(v);
}

/** "1.3.0-nightly.20260928.1a2b3c4" → "1.3.0"; null for names without one ("main-1a2b3c4"). */
export function baseVersion(v: string): string | null {
  return v.replace(/^v/, "").match(/^\d+\.\d+\.\d+/)?.[0] ?? null;
}

export interface UpdateSettings {
  /** Install updates on their own. */
  auto: boolean;
  channel: UpdateChannel;
  /** Local hour (0–23) automatic updates may start in (Stable, or Nightly once a day). */
  hour: number;
  /** Where automatic updates come from. */
  method: UpdateMethod;
  /** Nightly only: how soon an automatic update follows a new commit. */
  nightlyTiming: NightlyTiming;
}

export interface RunningBuild {
  version: string;
  /** Commit this build was made from (short), or null when unknown (a local build). */
  commit: string | null;
  /** A store version ("2026.09.26-1717") or "github" for builds the updater made. */
  build: string | null;
  /** Which channel this build came from, judged by its name. */
  channel: UpdateChannel;
  startedAt: number;
}

/** How Gluon is installed decides how it can replace itself. */
export type Install =
  | { kind: "umbrel"; appId: string; storeVersion: string | null }
  | { kind: "casaos"; project: string; service: string; image: string }
  | { kind: "compose"; project: string; service: string; image: string }
  | { kind: "docker"; container: string }
  | { kind: "development" }
  | { kind: "unknown" };

export interface GithubTarget {
  channel: UpdateChannel;
  /** A tag ("v1.2.0") or a commit sha: what gets downloaded. */
  ref: string;
  /** Version name for the build ("1.2.0", or "1.3.0-nightly.20260928.1a2b3c4"). */
  version: string;
  commit: string;
  /** Release name, or the commit's first line for a nightly. */
  title: string;
  notes: string;
  url: string;
  publishedAt: number;
  /** Nightly only: the changes on main since the running commit (newest first), when GitHub could say. */
  since: { count: number; titles: string[] } | null;
}

/**
 * How the newest build on the chosen channel relates to what's running:
 * newer (an update), current (the same), or ahead (running is past it: a nightly on Stable).
 */
export type UpdateRelation = "newer" | "current" | "ahead";

export interface UpdateOption {
  method: UpdateMethod;
  /** Plain sentence: "Download 1.2.0 from GitHub and build it here (a few minutes)." */
  label: string;
  available: boolean;
  /** Why it can't be used, when it can't. */
  reason: string | null;
  target: GithubTarget | null;
  /** For store updates: the version the store offers. */
  storeVersion: string | null;
}

export type UpdateStage = "download" | "build" | "apply" | "verify";

export interface UpdateRun {
  id: string;
  method: UpdateMethod;
  fromVersion: string;
  toVersion: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: "running" | "ok" | "failed";
  stage: UpdateStage | null;
  message: string | null;
  auto: boolean;
  username: string | null;
}

export interface UpdatesStatus {
  running: RunningBuild;
  install: Install;
  repo: string;
  settings: UpdateSettings;
  checkedAt: number | null;
  /** Error from the last check, in words. */
  checkError: string | null;
  /** Newest build on the chosen channel. */
  latest: GithubTarget | null;
  /** null until a check has found something. */
  relation: UpdateRelation | null;
  /** True when `latest` is newer than what's running. */
  updateAvailable: boolean;
  /**
   * Stable, while running a build ahead of the newest release: that release, when this install can
   * go back to it (POST /api/updates/apply { method: "github", allowOlder: true }).
   */
  goBack: GithubTarget | null;
  /** Can Gluon replace itself here at all (a Compose, CasaOS or Umbrel install)? */
  canSelfUpdate: boolean;
  options: UpdateOption[];
  current: UpdateRun | null;
  recent: UpdateRun[];
}

export interface UpdateLog {
  run: UpdateRun;
  lines: string[];
}
