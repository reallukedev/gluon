import { describe, expect, it } from "vitest";
import { parseProperties } from "./properties";
import { hostPathFor, parseMappingEnv, routerSettings } from "./discover";
import { LABEL_MAX, needsFor } from "./needs";
import { clash, reservedPorts } from "./ports";
import { hostDns, routeVerdict } from "./verdict";
import type { CraftyServer, McPing } from "@/lib/games-types";

describe("server.properties", () => {
  it("reads escapes, separators, comments and continued lines the way Java does", () => {
    const p = parseProperties(
      [
        "#Minecraft server properties",
        "! also a comment",
        "server-port=25569",
        "motd=\\u00A74\\u2620\\u00A7e w31c\\u00A7r\\nsecond",
        "level-name : world",
        "server-ip",
        "long=one \\",
        "    two",
        "key\\=with\\:sep=value",
      ].join("\r\n"),
    );
    expect(p.get("server-port")).toBe("25569");
    expect(p.get("motd")).toBe("§4☠§e w31c§r\nsecond");
    expect(p.get("level-name")).toBe("world");
    expect(p.get("server-ip")).toBe("");
    expect(p.get("long")).toBe("one two");
    expect(p.get("key=with:sep")).toBe("value");
    expect(p.has("#Minecraft server properties")).toBe(false);
  });
});

describe("finding mc-router's routes file", () => {
  it("reads settings from the environment, with command-line flags winning", () => {
    expect(routerSettings(["ROUTES_CONFIG=/config/routes.json", "ROUTES_CONFIG_WATCH=true", "CONNECTION_RATE_LIMIT=5"], ["/mc-router"])).toEqual({ routesConfig: "/config/routes.json", watch: true, port: 25565, mapping: null, fallback: null });
    expect(routerSettings(["ROUTES_CONFIG=/config/routes.json", "PORT=25565"], ["/mc-router", "--routes-config", "/data/r.json", "-routes-config-watch", "-port=25570"])).toMatchObject({ routesConfig: "/data/r.json", watch: true, port: 25570 });
    expect(parseMappingEnv("a.example.com=srv:25565,\nb.example.com = other:25566")).toEqual([
      ["a.example.com", "srv:25565"],
      ["b.example.com", "other:25566"],
    ]);
  });

  it("maps a container path to this server through the closest mount", () => {
    const mounts = [
      { Source: "/home/sam/proxy", Destination: "/data" },
      { Source: "/home/sam/proxy/mc-router/", Destination: "/config" },
      { Source: "/srv/other", Destination: "/config/extra" },
    ];
    expect(hostPathFor(mounts, "/config/routes.json")).toBe("/home/sam/proxy/mc-router/routes.json");
    expect(hostPathFor(mounts, "/config/extra/routes.json")).toBe("/srv/other/routes.json");
    expect(hostPathFor(mounts, "/configs/routes.json")).toBeNull();
  });
});

describe("router port needs", () => {
  it("forwards 25565 for mc-router and each game port's range, with stable keys and short labels", () => {
    const needs = needsFor({ hostPort: 25565, addresses: 3 }, [
      { id: "ab12cd34", name: "Minecraft Bedrock edition", game: "bedrock", protocol: "udp", hostMin: 19132, hostMax: 19132, publicMin: 19132, address: "mc.example.com" },
      { id: "ef56ab78", name: "Valheim", game: "valheim", protocol: "udp", hostMin: 2456, hostMax: 2457, publicMin: 3456, address: null },
    ]);
    expect(needs.map((n) => [n.key, n.label, n.protocol, n.min, n.max, n.hostPort])).toEqual([
      ["game-minecraft", "Minecraft", "tcp", 25565, 25565, 25565],
      ["game-port-ab12cd34", "MC Bedrock", "udp", 19132, 19132, 19132],
      ["game-port-ef56ab78", "Valheim", "udp", 3456, 3457, 2456],
    ]);
    expect(needs[1]!.why).toBe("Players join mc.example.com:19132.");
    for (const n of needs) expect(n.label.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(needsFor(null, [])).toEqual([]);
  });
});

const ping = (p: Partial<McPing>): McPing => ({ ok: false, ms: null, version: null, protocol: null, motd: null, online: null, max: null, players: [], favicon: null, error: "x", at: 0, ...p });
const srv = (name: string, running: boolean | null): CraftyServer => ({ id: name, name, named: "crafty", port: 25569, motd: null, type: "minecraft-java", running });

describe("what an address does", () => {
  it.each([
    [ping({ ok: true, version: "1.21.10", online: 2, max: 20 }), [srv("Survival", true)], "running", "Answers · 1.21.10 · 2 of 20 playing"],
    [ping({}), [srv("Creative", false), srv("Skyblock", false)], "stopped", "Both stopped in Crafty"],
    [ping({}), [srv("Creative", false), srv("Skyblock", true)], "unhealthy", "Running in Crafty, not answering yet"],
    [ping({}), [srv("Creative", null)], "stopped", "Not answering, probably stopped"],
    [ping({}), [], "unhealthy", "No Crafty server uses this port"],
  ] as const)("%#", (p, servers, state, summary) => {
    expect(routeVerdict(p, { kind: "crafty", port: 25569, servers: [...servers] }, "running", "crafty_container:25569")).toEqual({ state, summary });
  });

  it("names the network problem when mc-router can't reach a container", () => {
    expect(routeVerdict(ping({}), { kind: "container", name: "paper", running: true, sharesNetwork: false }, "running", "paper:25565").summary).toBe("Not on mc-router's Docker network");
  });

  it("says Cloudflare's proxy can't carry Minecraft", () => {
    const r = { name: "mc.example.com", a: ["104.21.1.1"], aaaa: [], proxied: true, matchesPublicIp: null, status: "ok" as const, message: "", resolver: "1.1.1.1" };
    expect(hostDns("mc.example.com", r, true)).toMatchObject({ status: "proxied", message: expect.stringMatching(/DNS only/) });
  });
});

describe("game ports that would collide", () => {
  const port = (protocol: "tcp" | "udp" | "both", hostMin: number, hostMax = hostMin, publicMin = hostMin) => ({ name: "Test", game: null, protocol, hostMin, hostMax, publicMin, address: null });
  // What portNeeds() lists on a server with Caddy, chat and Mumble set up, plus mc-router's own need.
  const needs = [
    { key: "web-https", label: "Web (HTTPS)", why: "", min: 443, max: 443, hostPort: 443, protocol: "tcp" as const },
    { key: "voice", label: "Mumble", why: "", min: 64738, max: 64738, hostPort: 64738, protocol: "both" as const },
    { key: "game-minecraft", label: "Minecraft", why: "", min: 25565, max: 25565, hostPort: 25565, protocol: "tcp" as const },
    { key: "game-port-ab12cd34", label: "Valheim", why: "", min: 2456, max: 2457, hostPort: 2456, protocol: "udp" as const },
  ];

  it("refuses public ports Gluon's own addresses use, even before Caddy is set up", () => {
    expect(clash(port("both", 443), [], reservedPorts(needs))).toMatch(/443.*Web \(HTTPS\)/);
    expect(clash(port("udp", 8443, 8443, 443), [], reservedPorts(needs))).toMatch(/443/);
    expect(clash(port("tcp", 80), [], reservedPorts([]))).toMatch(/80/);
    expect(clash(port("udp", 64700, 64800), [], reservedPorts(needs))).toMatch(/Mumble/);
    expect(clash(port("tcp", 25565), [], reservedPorts(needs))).toMatch(/Minecraft/);
  });

  it("leaves a different protocol on the same number alone, and skips game ports' own needs", () => {
    expect(clash(port("udp", 25565), [], reservedPorts(needs))).toBeNull();
    // The entry being edited is already a need; it mustn't clash with itself.
    expect(clash(port("udp", 2456, 2457), [], reservedPorts(needs))).toBeNull();
  });
});
