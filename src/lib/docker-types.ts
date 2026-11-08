import type { LineState } from "./types";

export type AppSource = "gluon" | "casaos" | "umbrel" | "compose" | "docker";

export interface AppRef {
  id: string;
  name: string;
  source: AppSource;
}

/**
 * Something Gluon must not touch lightly. `block`: refused outright (Gluon's own image or volume).
 * `warn`: allowed only one at a time, after typing its name (the home-server platform's own parts).
 */
export interface Guard {
  level: "block" | "warn";
  who: "gluon" | "umbrel" | "casaos";
  message: string;
}

export interface ContainerRef {
  id: string;
  name: string;
  state: string;
  line: LineState;
  app: AppRef | null;
  self: boolean;
  /** Part of the platform itself (Umbrel's container, its auth and Tor proxies). */
  platform: "umbrel" | null;
}

export type ImageUse = "running" | "stopped" | "unused" | "leftover";

export interface DockerImage {
  id: string;
  short: string;
  repo: string | null;
  /** "repo:tag" references (never digests). */
  tags: string[];
  digests: string[];
  created: number;
  size: number;
  shared: number | null;
  /** What removing it alone would give back (size minus shared). */
  own: number;
  containers: ContainerRef[];
  use: ImageUse;
  /** Built by `docker build` / Compose (a leftover of a rebuild when it has no tag). */
  built: boolean;
  /** In-use images built on top of this one ("node:24-bookworm" is the base of Gluon's image). */
  baseOf: string[];
  /** An unused image that is an older version of one an app runs now. */
  olderOf: AppRef | null;
  /** The app it belongs to: the app of its containers, else the one it's an older version of. */
  app: AppRef | null;
  guard: Guard | null;
}

export interface ImagesResponse {
  images: DockerImage[];
  /** Everything Docker keeps for images, counted once (from its disk-usage report), when known. */
  total: number | null;
  platform: "umbrel" | "casaos" | "none";
}

export type PullEvent =
  | { type: "status"; text: string }
  | { type: "layer"; id: string; phase: "waiting" | "downloading" | "verifying" | "downloaded" | "extracting" | "done" | "exists"; current?: number; total?: number }
  | { type: "done"; ok: boolean; message: string; changed?: boolean; imageId?: string }
  | { type: "error"; message: string };

export interface VolumeMount extends ContainerRef {
  destination: string;
  rw: boolean;
}

export interface DockerVolume {
  name: string;
  /** Created without a name (a 64-character id), usually by an image's VOLUME line. */
  anonymous: boolean;
  driver: string;
  mountpoint: string | null;
  created: number | null;
  project: string | null;
  composeName: string | null;
  containers: VolumeMount[];
  app: AppRef | null;
  guard: Guard | null;
  labels: Record<string, string>;
  options: Record<string, string>;
}

export interface VolumesResponse {
  volumes: DockerVolume[];
  platform: "umbrel" | "casaos" | "none";
}

/** Volume sizes come from Docker's disk-usage report, which walks every file: fetched separately. */
export interface VolumeSizes {
  at: number;
  sizes: Record<string, number | null>;
}

export interface NetworkMember extends ContainerRef {
  ipv4: string | null;
  ipv6: string | null;
  /** The network the container was created on (its NetworkMode): not disconnected from here. */
  primary: boolean;
}

export interface DockerNetwork {
  id: string;
  short: string;
  name: string;
  driver: string;
  scope: string;
  created: number | null;
  internal: boolean;
  attachable: boolean;
  ipv6: boolean;
  subnets: { subnet: string; gateway: string | null }[];
  /** bridge, host and none: Docker's own, never removable. */
  builtin: boolean;
  project: string | null;
  app: AppRef | null;
  containers: NetworkMember[];
  guard: Guard | null;
}

/** A container that could join a network (not on the host's network or another container's). */
export interface Attachable {
  id: string;
  name: string;
  state: string;
  line: LineState;
  app: AppRef | null;
  networks: string[];
  self: boolean;
  platform: "umbrel" | null;
}

export interface NetworksResponse {
  networks: DockerNetwork[];
  containers: Attachable[];
}

export interface DockerDisk {
  root: string | null;
  fs: { mount: string; size: number; free: number } | null;
  total: number;
  images: { count: number; bytes: number; unused: number; unusedBytes: number };
  containers: { count: number; bytes: number; stopped: number; stoppedBytes: number };
  volumes: { count: number; bytes: number; unused: number; unusedBytes: number };
  buildCache: { count: number; bytes: number; reclaimable: number };
}

export type CleanupKind = "images" | "containers" | "volumes" | "buildcache";

export interface CleanupItem {
  id: string;
  label: string;
  detail: string | null;
  note: string | null;
  bytes: number | null;
  /** Ticked when the preview opens: things that are safe to lose. */
  preselect: boolean;
  caution: string | null;
  app: AppRef | null;
}

export interface CleanupPlan {
  kind: CleanupKind;
  items: CleanupItem[];
  /** Left out on purpose, with the reason (Gluon's own image, an Umbrel part…). */
  kept: { label: string; reason: string }[];
  /** For the build cache, which is cleared as a whole. */
  bytes: number;
}

export interface CleanupResult {
  message: string;
  freed: number | null;
  removed: number;
  skipped: { label: string; reason: string }[];
}

export interface ContainerInspect {
  id: string;
  name: string;
  state: string;
  line: LineState;
  health: string | null;
  app: AppRef | null;
  self: boolean;
  platform: "umbrel" | null;
  image: { ref: string; id: string };
  created: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  restartCount: number;
  restartPolicy: string;
  command: string;
  entrypoint: string;
  workingDir: string | null;
  user: string | null;
  networkMode: string;
  ports: { host: number; container: number; proto: string; ip: string }[];
  mounts: { type: string; source: string; destination: string; rw: boolean; volume: string | null }[];
  networks: { name: string; ipv4: string | null; ipv6: string | null }[];
  labels: number;
  /** Docker's full inspect output, with secret-looking environment values hidden. */
  raw: unknown;
}

export type ExecEvent =
  | { type: "start"; argv: string[] }
  | { type: "out"; text: string }
  | { type: "err"; text: string }
  | { type: "done"; exitCode: number | null; ms: number; truncated: boolean; timedOut: boolean }
  | { type: "error"; message: string };
