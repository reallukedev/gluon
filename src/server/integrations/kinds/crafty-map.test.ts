import { describe, expect, test } from "vitest";
import { playerNames, STARTING_GRACE_MS, toServer, zoneOffset } from "./crafty-map";

// Shapes recorded from Crafty 4.11.0 (registry.gitlab.com/crafty-controller/crafty-4:4.11.0) running in UTC.
// GET /api/v2/servers → data[]:
const item = {
  server_id: "07d7c2b2-8894-4409-a726-8b3b368b63f9",
  created: "2026-10-25T20:45:33.907297",
  server_name: "Survival",
  path: "/crafty/servers/07d7c2b2-8894-4409-a726-8b3b368b63f9",
  executable: "vanilla.jar",
  execution_command: "java -Xms1000M -Xmx1000M -jar vanilla.jar nogui",
  stop_command: "stop",
  server_ip: "127.0.0.1",
  server_port: 25599,
  type: "minecraft-java",
  show_status: true,
  shutdown_timeout: 60,
  ignored_exits: "0",
  count_players: true,
};

// GET /api/v2/servers/{id}/stats → data, a second after start_server: the process is up, the game isn't answering.
const starting = {
  stats_id: 2,
  created: "2026-10-25T20:46:14.836046",
  server_id: item,
  started: "2026-10-25 20:46:14",
  running: true,
  cpu: 48.95,
  mem: 150171648.0,
  mem_percent: 2.0,
  world_name: "Survival",
  world_size: "143.0B",
  server_port: 25599,
  int_ping_results: "False",
  online: 0,
  max: 0,
  players: "False",
  desc: "False",
  icon: null,
  version: "False",
  updating: false,
  waiting_start: false,
  crashed: false,
  importing: false,
};

// The same once the game answers Crafty's ping, with three people on (Crafty stores the sample as a Python list).
const playing = {
  ...starting,
  stats_id: 3,
  created: "2026-10-25T21:02:09.160536",
  started: "2026-10-25 21:01:38",
  cpu: 0.0,
  mem: 1034354688.0,
  mem_percent: 17.0,
  int_ping_results: "True",
  online: 3,
  max: 20,
  players: "['Steve', 'Alex_the_Builder', 'notch']",
  desc: "A Minecraft Server",
  version: "1.21.11",
};

// After stop_server.
const stopped = { ...starting, stats_id: 11, created: "2026-10-25T20:49:34.830303", started: "False", running: false, cpu: 0.0, mem: 0.0 };

const at = (iso: string) => Date.parse(iso);

describe("a server through its life", () => {
  test("starting: up but not answering, so no players yet, and uptime from Crafty's wall clock", () => {
    const now = at("2026-10-25T20:46:20Z");
    const s = toServer(item, starting, { now, offset: 0 })!;
    expect(s).toMatchObject({ name: "Survival", game: "Minecraft", state: "starting", line: "starting", running: true, players: null, version: null, port: 25599, stopTimeoutMs: 60_000 });
    expect(s.startedAt).toBe(at("2026-10-25T20:46:14Z"));
    expect(s.cpu).toBe(48.95);
  });

  test("running: players and version come from the game's answer", () => {
    const s = toServer(item, playing, { now: at("2026-10-25T21:02:20Z"), offset: 0 })!;
    expect(s).toMatchObject({ state: "running", line: "running", players: { online: 3, max: 20, names: ["Steve", "Alex_the_Builder", "notch"] }, version: "1.21.11", memory: 1034354688 });
    expect(s.run).toBe("2026-10-25 21:01:38");
  });

  test("stopped: no figures, but the version it last ran is kept", () => {
    const s = toServer(item, stopped, { now: at("2026-10-25T20:50:00Z"), offset: 0, lastVersion: "1.21.11" })!;
    expect(s).toMatchObject({ state: "stopped", line: "stopped", running: false, players: null, startedAt: null, run: null, cpu: null, memory: null, version: "1.21.11" });
  });

  test("still not answering long after starting reads as a problem, not as starting", () => {
    const now = at("2026-10-25T20:46:14Z") + STARTING_GRACE_MS + 1000;
    expect(toServer(item, starting, { now, offset: 0 })!.state).toBe("unresponsive");
  });

  test.each([
    ["crashed", { running: false, started: "False", crashed: true }, "unhealthy"],
    ["waiting", { running: false, started: "False", waiting_start: true }, "starting"],
    ["updating", { updating: true }, "starting"],
    ["importing", { running: false, importing: true }, "starting"],
  ] as const)("Crafty's %s flag", (state, patch, line) => {
    const s = toServer(item, { ...stopped, ...patch }, { now: at("2026-10-25T20:50:00Z"), offset: 0 })!;
    expect(s.state).toBe(state);
    expect(s.line).toBe(line);
  });

  test("a game Crafty can't ping counts as running once its process is up", () => {
    const steam = { ...item, type: "steam_cmd" };
    expect(toServer(steam, { ...starting, server_id: steam }, { now: at("2026-10-25T21:30:00Z"), offset: 0 })!.state).toBe("running");
  });

  test("a new server with no stats yet is still listed, in an unknown state", () => {
    expect(toServer(item, null, { now: Date.now(), offset: 0 })).toMatchObject({ name: "Survival", state: "unknown", line: "unknown", running: false });
  });

  test("ids that couldn't be a Crafty UUID are dropped (they go into URLs)", () => {
    expect(toServer({ ...item, server_id: "../users" }, null, { now: 0, offset: 0 })).toBeNull();
  });
});

describe("Crafty's time zone", () => {
  test("worked out from its freshest record when Crafty runs in another zone", () => {
    // Crafty on UTC+02:00 wrote 22:46:14 local; it's 20:46:30 UTC now.
    const now = at("2026-10-25T20:46:30Z");
    const offset = zoneOffset(["2026-10-25T21:40:00.0", "2026-10-25T22:46:14.836046"], now);
    expect(offset).toBe(2 * 3600_000);
    const s = toServer(item, { ...starting, created: "2026-10-25T22:46:14.836046", started: "2026-10-25 22:46:14" }, { now, offset })!;
    expect(s.startedAt).toBe(at("2026-10-25T20:46:14Z"));
  });

  test("unknown when no record is fresh enough to be sure, so uptime isn't guessed", () => {
    expect(zoneOffset(["2026-10-25T20:00:00"], at("2026-10-25T20:08:00Z"))).toBeNull();
    expect(zoneOffset([undefined, "False"], Date.now())).toBeNull();
    expect(toServer(item, starting, { now: Date.now(), offset: null })!.startedAt).toBeNull();
  });
});

describe("player names", () => {
  test("Python quoting, including a name with an apostrophe", () => {
    expect(playerNames(`['Steve', "O'Brien", 'a\\\\b']`)).toEqual(["Steve", "O'Brien", "a\\b"]);
  });
  test("nothing when the game didn't answer", () => {
    expect(playerNames("False")).toEqual([]);
    expect(playerNames("[]")).toEqual([]);
    expect(playerNames(0)).toEqual([]);
  });
});
