/** Settings → Updates: what's running, what's available, and how Gluon can update itself. */

export type UpdateChannel = "releases" | "main";
export type UpdateMethod = "github" | "umbrel" | "casaos";

export interface UpdateSettings {
  /** Install updates on their own, in the hour below. */
  auto: boolean;
  /** Releases (tagged versions) or every change pushed to main. */
  channel: UpdateChannel;
  /** Local hour (0–23) automatic updates may start in. */
  hour: number;
  /** Where automatic updates come from. */
  method: UpdateMethod;
}

export interface RunningBuild {
  version: string;
  /** Commit this build was made from (short), or null when unknown (a local build). */
  commit: string | null;
  /** A store version ("2026.09.26-1717") or "github" for builds the updater made. */
  build: string | null;
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
  /** A tag ("v1.2.0") or a commit sha: what gets downloaded. */
  ref: string;
  /** Version name for the build ("1.2.0", or "main-1a2b3c4"). */
  version: string;
  commit: string;
  title: string;
  notes: string;
  url: string;
  publishedAt: number;
}

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
  latest: GithubTarget | null;
  /** True when `latest` is newer than what's running. */
  updateAvailable: boolean;
  options: UpdateOption[];
  current: UpdateRun | null;
  recent: UpdateRun[];
}

export interface UpdateLog {
  run: UpdateRun;
  lines: string[];
}
