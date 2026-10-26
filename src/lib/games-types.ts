/** Network → Game servers, shared by the API and the panel. No server imports. */
import type { LineState } from "./types";

export interface McPing {
  ok: boolean;
  ms: number | null;
  version: string | null;
  protocol: number | null;
  motd: string | null;
  online: number | null;
  max: number | null;
  /** Names the server shares from who's online (servers send a few at most). */
  players: string[];
  favicon: string | null;
  error: string | null;
  at: number;
}

/** Does a name lead players to this home? */
export interface HostDns {
  status: "home" | "proxied" | "elsewhere" | "missing" | "error" | "literal";
  message: string;
  addresses: string[];
}

export interface CraftyServer {
  /** The folder name under Crafty's servers folder (Crafty's server id). */
  id: string;
  name: string;
  /** Where the name came from: Crafty's own list, the server's MOTD, or only its folder. */
  named: "crafty" | "motd" | "folder";
  port: number | null;
  motd: string | null;
  type: string;
  /** null when Gluon can't see Crafty's processes. */
  running: boolean | null;
}

export type McTarget =
  /** A port on the Crafty container: every Crafty server set to that port (only one can run at a time). */
  | { kind: "crafty"; port: number; servers: CraftyServer[] }
  | { kind: "container"; name: string; running: boolean; sharesNetwork: boolean }
  | { kind: "address" };

export interface McRoute {
  /** The address players type, as written in the routes file. */
  host: string;
  backend: string;
  target: McTarget;
  /** Through mc-router, saying this address. */
  ping: McPing | null;
  dns: HostDns | null;
  state: LineState;
  summary: string;
}

export interface McDefault {
  backend: string;
  target: McTarget;
  ping: McPing | null;
  state: LineState;
  summary: string;
}

export interface McRouterInfo {
  status: "missing" | "stopped" | "running";
  container: string | null;
  version: string | null;
  /** The routes file on this server. */
  file: string | null;
  /** Gluon may change the file. When false, `reason` says why. */
  editable: boolean;
  reason: string | null;
  watch: boolean;
  /** The port players connect to on this server. */
  hostPort: number | null;
  networks: string[];
  /** The file is there but isn't something mc-router can read. */
  broken: { message: string; line: number | null; excerpt: string } | null;
  /** Fingerprint of the file as read; changes must name it, so edits made by hand meanwhile aren't overwritten. */
  rev: string | null;
}

export interface CraftyInfo {
  status: "missing" | "stopped" | "running";
  container: string | null;
  servers: CraftyServer[];
  /** Crafty's own server names were readable. */
  names: boolean;
  /** Gluon can tell which servers are running. */
  live: boolean;
}

export type GameProtocol = "tcp" | "udp" | "both";

export interface GamePort {
  id: string;
  name: string;
  game: string | null;
  protocol: GameProtocol;
  hostMin: number;
  hostMax: number;
  publicMin: number;
  address: string | null;
  needKey: string;
  publishedBy: { container: string; app: string | null; running: boolean } | null;
  dns: HostDns | null;
}

export interface GamesStatus {
  mcRouter: McRouterInfo;
  crafty: CraftyInfo;
  routes: McRoute[];
  fallback: McDefault | null;
  /** The domain new Minecraft addresses go under, guessed from the ones there are. */
  domain: string | null;
  publicIp: { v4: string | null; v6: string[] };
  javaNeedKey: string;
  ports: GamePort[];
  checkedAt: number | null;
}

export interface McChangeResult {
  status: GamesStatus;
  /** What the changed address answers now, through mc-router. */
  check: { host: string | null; ping: McPing | null } | null;
  /** mc-router took the change without a restart. */
  applied: boolean;
  /** History entry that puts the file back as it was. */
  undo: number | null;
  /** Anything the admin should know about how mc-router took it. */
  note: string | null;
}

export interface McHistoryEntry {
  id: number;
  at: number;
  summary: string;
  username: string | null;
  mappings: number;
}

export const JAVA_NEED_KEY = "game-minecraft";
export const portNeedKey = (id: string) => `game-port-${id}`;

/** Common games that need their own ports (they can't share one by name the way Minecraft Java can). */
export const GAME_PRESETS: { id: string; name: string; protocol: GameProtocol; ports: string; note?: string }[] = [
  { id: "bedrock", name: "Minecraft Bedrock", protocol: "udp", ports: "19132" },
  { id: "valheim", name: "Valheim", protocol: "udp", ports: "2456-2457" },
  { id: "terraria", name: "Terraria", protocol: "tcp", ports: "7777" },
  { id: "satisfactory", name: "Satisfactory", protocol: "both", ports: "7777", note: "Satisfactory 1.0 also needs TCP 8888. Add it as a second game port." },
  { id: "factorio", name: "Factorio", protocol: "udp", ports: "34197" },
  { id: "palworld", name: "Palworld", protocol: "udp", ports: "8211" },
  { id: "zomboid", name: "Project Zomboid", protocol: "udp", ports: "16261-16262" },
];
