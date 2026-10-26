// Crafty Controller 4: turning API v2 answers into what the Minecraft servers widget draws. Pure, so it can be
// tested on shapes recorded from a real Crafty 4.11.0.
import type { LineState } from "@/lib/types";
import type { CraftyServer, CraftyServerState } from "@/lib/widgets-types";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() && v !== "False" && v !== "None" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Crafty stores some flags as text: "True" / "False". */
const yes = (v: unknown): boolean => v === true || v === "True" || v === "true" || v === 1;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** How long a server may be up without answering before Gluon stops calling it "starting". */
export const STARTING_GRACE_MS = 5 * 60_000;

/**
 * Crafty writes local wall-clock times with no zone ("2026-10-25 20:46:14", "2026-10-25T20:46:33.920388").
 * Read them as if they were UTC; `zoneOffset` says how far that is from the real instant.
 */
export function wallClock(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms);
}

/**
 * Crafty's time zone, as an offset from UTC, worked out from its freshest stats record: Crafty saves one every
 * 30 seconds, so that record's wall-clock time is "now" in Crafty's zone give or take a little. Zones are whole
 * quarter hours, so rounding absorbs the lag. null when no record is fresh enough to be sure.
 */
export function zoneOffset(created: unknown[], now: number): number | null {
  const times = created.map(wallClock).filter((t): t is number => t !== null);
  if (!times.length) return null;
  const freshest = Math.max(...times);
  const quarter = 15 * 60_000;
  const offset = Math.round((freshest - now) / quarter) * quarter;
  // The record may be a few minutes old (busy Crafty, longer stats interval), but not so old the rounding could slip.
  const lag = now + offset - freshest;
  return lag >= -60_000 && lag < 5 * 60_000 ? offset : null;
}

/** Player names from Crafty's stats: a Python list written as text ("['Steve', 'Alex']"), or "False". */
export function playerNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 50);
  const s = str(v);
  if (!s || !s.startsWith("[")) return [];
  const out: string[] = [];
  // Python quotes with ' unless the name holds one, then with ".
  for (const m of s.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const name = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim();
    if (name) out.push(name.slice(0, 64));
    if (out.length >= 50) break;
  }
  return out;
}

/** Server types whose game answers a status ping (Crafty's `int_ping_results`). Steam games don't. */
const PINGS = new Set(["minecraft-java", "minecraft-bedrock", "raknet", "hytale"]);

export function gameOf(type: unknown): string {
  switch (str(type)) {
    case "minecraft-java":
      return "Minecraft";
    case "minecraft-bedrock":
    case "raknet":
      return "Minecraft Bedrock";
    case "hytale":
      return "Hytale";
    case "steam_cmd":
      return "Steam game";
    default:
      return "Game";
  }
}

export const LINE: Record<CraftyServerState, LineState> = {
  running: "running",
  starting: "starting",
  waiting: "starting",
  updating: "starting",
  importing: "starting",
  stopped: "stopped",
  crashed: "unhealthy",
  unresponsive: "unhealthy",
  unknown: "unknown",
};

export function stateOf(stats: Record<string, unknown>, type: unknown, startedAt: number | null, now: number): CraftyServerState {
  if (yes(stats.updating)) return "updating";
  if (yes(stats.importing)) return "importing";
  if (yes(stats.running)) {
    if (!PINGS.has(str(type) ?? "") || yes(stats.int_ping_results)) return "running";
    return startedAt === null || now - startedAt < STARTING_GRACE_MS ? "starting" : "unresponsive";
  }
  if (yes(stats.crashed)) return "crashed";
  if (yes(stats.waiting_start)) return "waiting";
  return "stopped";
}

export interface MapContext {
  now: number;
  /** From `zoneOffset`; null leaves uptime unknown. */
  offset: number | null;
  /** The version this server reported while it last ran (Gluon remembers it in memory). */
  lastVersion?: string | null;
}

/**
 * One server from GET /api/v2/servers (`item`) and GET /api/v2/servers/{id}/stats (`stats`, which also nests the
 * server row as `server_id`). Either may be missing; the result is still drawable.
 */
export function toServer(item: unknown, stats: unknown, ctx: MapContext): CraftyServer | null {
  const st = obj(stats);
  const row = { ...obj(st.server_id), ...obj(item) };
  const id = str(row.server_id);
  if (!id || !/^[a-z0-9-]{1,64}$/.test(id)) return null;
  const type = row.type;
  const running = yes(st.running);
  const startedWall = running ? wallClock(st.started) : null;
  const startedAt = startedWall !== null && ctx.offset !== null ? Math.min(ctx.now, startedWall - ctx.offset) : null;
  const known = Object.keys(st).length > 0;
  const state: CraftyServerState = known ? stateOf(st, type, startedAt, ctx.now) : "unknown";
  const answered = running && yes(st.int_ping_results);
  const online = num(st.online) ?? 0;
  const max = num(st.max) ?? 0;
  const timeout = num(row.shutdown_timeout);
  return {
    id,
    name: str(row.server_name) ?? str(st.world_name) ?? "Unnamed server",
    game: gameOf(type),
    state,
    line: LINE[state],
    running,
    players: answered ? { online, max, names: playerNames(st.players) } : null,
    version: (answered ? str(st.version) : null) ?? ctx.lastVersion ?? null,
    startedAt,
    run: running ? str(st.started) : null,
    cpu: running ? num(st.cpu) : null,
    memory: running ? num(st.mem) : null,
    port: num(row.server_port) ?? num(st.server_port),
    stopTimeoutMs: Math.min(Math.max(timeout ?? 60, 10), 600) * 1000,
  };
}

/** By name only: a row must not jump away while someone is pressing its Stop button. */
export function sortServers(list: CraftyServer[]): CraftyServer[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** Crafty's error envelope: `{ status: "error", error: "NOT_AUTHORIZED", error_data: "…" }`. */
export function craftyError(body: string): { code: string; detail: string } | null {
  try {
    const j = obj(JSON.parse(body));
    if (j.status !== "error") return null;
    return { code: String(j.error ?? ""), detail: String(j.error_data ?? j.info ?? "") };
  } catch {
    return null;
  }
}
