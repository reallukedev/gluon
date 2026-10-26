/**
 * Shapes shared by "Move to Gluon" and "Uninstall" (src/server/apps) and their screens
 * (src/components/apps). No server imports here.
 */

export type MoveSource = "compose" | "casaos" | "umbrel" | "docker";

/** Something Gluon copies into the new app's folder before it starts the copy. */
export interface MoveCopy {
  /** Host path read from (a folder, a file, or a Docker volume's data folder). */
  from: string;
  /** Host path written to, always inside the new app's folder. */
  to: string;
  kind: "folder" | "file" | "volume";
  /** Volume name for kind "volume". */
  volume?: string;
  services: string[];
  /** Bytes, when measuring finished in time. */
  size: number | null;
  /** The source doesn't exist yet (the app creates it on first start). */
  missing: boolean;
}

/** A host folder the app keeps using where it is. Never copied, never deleted. */
export interface MoveStay {
  path: string;
  services: string[];
  readOnly: boolean;
}

export interface MovePort {
  host: number;
  container: number | null;
  proto: "tcp" | "udp";
  service: string;
}

export interface MovePlan {
  /** Changes whenever what the move would do changes; the move refuses a stale one. */
  id: string;
  appId: string;
  name: string;
  source: MoveSource;
  /** The new app's id (its Compose project name). */
  newId: string;
  /** The new app's folder on the server. */
  folder: string;
  compose: string;
  copies: MoveCopy[];
  stays: MoveStay[];
  /** Docker volumes other apps use too: the copy keeps using them in place. */
  sharedVolumes: string[];
  ports: MovePort[];
  stops: { name: string; containers: string[]; via: "umbrel" | "compose" | "containers" };
  space: { needed: number; free: number | null; enough: boolean; unmeasured: string[] };
  warnings: string[];
  /** Reasons the move can't run. Empty when it can. */
  blockers: string[];
}

export type MoveStage = "stop" | "copy" | "start" | "check";

export type MoveEvent =
  | { type: "stage"; stage: MoveStage }
  | { type: "step"; text: string }
  | { type: "line"; text: string; stream?: "out" | "err" }
  | { type: "progress"; done: number; total: number; current?: string }
  | { type: "result"; ok: boolean; rolledBack: boolean; newId: string | null; message: string; detail?: string }
  | { type: "error"; message: string };

export interface MoveJob {
  appId: string;
  newId: string;
  name: string;
  startedAt: number;
  finishedAt: number | null;
  events: MoveEvent[];
}

// ---------------------------------------------------------------- uninstall

export interface UninstallItem {
  kind: "folder" | "file" | "volume";
  /** Host path (folders and files) or volume name. */
  target: string;
  size: number | null;
  note?: string;
}

export interface UninstallMode {
  /** What goes: always the containers, plus these. */
  removes: UninstallItem[];
  /**
   * Deletable, but only when ticked one by one: folders that look like a media library (music,
   * movies, photos, downloads) or hold a lot. Always empty when keeping data.
   */
  optional: UninstallItem[];
  /** What stays on disk. */
  keeps: UninstallItem[];
}

export interface UninstallPlan {
  id: string;
  appId: string;
  name: string;
  source: "gluon" | "compose" | "casaos" | "docker";
  containers: string[];
  /** How the containers go: `docker compose down` or one by one. */
  via: "compose" | "containers";
  keep: UninstallMode;
  everything: UninstallMode;
}

// ---------------------------------------------------------------- who can do what

interface AppLike {
  source: string;
  self: boolean;
  kind: "stack" | "container";
  containers: unknown[];
  copyOf: unknown | null;
  umbrel: { state: string } | null;
  gluon?: { builderId: string | null } | null;
}

const UMBREL_BUSY = new Set(["installing", "updating", "uninstalling", "starting", "stopping", "restarting"]);

/** Why an app can't be moved to Gluon right now, or null when it can. */
export function moveBlock(a: AppLike): string | null {
  if (a.self) return "Gluon can't move itself.";
  if (a.source === "gluon") return "It already runs from Gluon.";
  if (a.copyOf) return "This is an old copy. Move the one in use instead.";
  if (a.umbrel && UMBREL_BUSY.has(a.umbrel.state)) return "Umbrel is busy with this app. Try again when it's done.";
  if (!a.containers.length) return "It has no containers to move.";
  return null;
}

/** Why Gluon can't uninstall an app itself, or null when it can. */
export function uninstallBlock(a: AppLike): string | null {
  if (a.self) return "Gluon can't uninstall itself.";
  if (a.source === "umbrel") return "Umbrel installed it, so it's uninstalled through Umbrel.";
  if (a.gluon?.builderId) return "You made this app in Gluon. Remove it from its builder page.";
  if (!a.containers.length) return "It has no containers left.";
  return null;
}

/**
 * How an app is uninstalled from Gluon: Umbrel's own apps through Umbrel (which deletes their
 * data), apps made in the builder from their builder page, everything else with Gluon's dialog.
 */
export function uninstallRoute(a: AppLike): { via: "umbrel" | "gluon" | "builder"; block: string | null } {
  if (a.self) return { via: "gluon", block: "Gluon can't uninstall itself." };
  if (a.gluon?.builderId) return { via: "builder", block: null };
  if (a.source === "umbrel") {
    if (!a.umbrel) return { via: "umbrel", block: "Gluon can't reach Umbrel right now, and Umbrel uninstalls its own apps. Try again in a minute." };
    return { via: "umbrel", block: UMBREL_BUSY.has(a.umbrel.state) ? "Umbrel is busy with this app. Try again when it's done." : null };
  }
  return { via: "gluon", block: uninstallBlock(a) };
}
