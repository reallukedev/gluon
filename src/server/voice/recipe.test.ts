import { describe, expect, it } from "vitest";
import { parseCompose, readService } from "@/lib/builder/compose";
import { analyze } from "@/lib/builder/analyze";
import { MUMBLE_IMAGE, mumbleLink, slugFor, voiceRecipe } from "./recipe";

const secrets = { iceWrite: "write-secret", iceRead: "read-secret" };

describe("voiceRecipe", () => {
  const r = voiceRecipe({ name: "Friday Voice", welcome: "Hi <b>all</b>, costs $0", password: "join-pw", port: 64739 }, secrets, 6503);
  const parsed = parseCompose(r.spec.compose);
  const svc = readService(parsed.doc, "mumble-server");

  it("makes a compose file the builder accepts", () => {
    expect(parsed.ok).toBe(true);
    const a = analyze(r.spec.compose, { source: "compose", target: "compose", web: r.spec.web, secrets: { "mumble-server": Object.keys(r.secrets["mumble-server"]!) } });
    expect(a.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("pins the image to a release, never latest", () => {
    expect(svc.image).toBe(MUMBLE_IMAGE);
    expect(svc.image).not.toMatch(/:latest$/);
  });

  it("publishes the voice port on TCP and UDP, and Ice on loopback only", () => {
    expect(svc.ports.map((p) => [p.ip, p.host, p.container, p.proto])).toEqual([
      ["", 64739, 64738, "tcp"],
      ["", 64739, 64738, "udp"],
      ["127.0.0.1", 6503, 6502, "tcp"],
    ]);
    expect(svc.env.find((e) => e.key === "MUMBLE_CONFIG_ICE")?.value).toBe("tcp -h 0.0.0.0 -p 6502");
  });

  it("keeps data in the app folder", () => {
    expect(svc.volumes.map((v) => [v.kind, v.source, v.target])).toEqual([["data", "mumble", "/data"]]);
  });

  it("keeps secrets out of the compose text", () => {
    for (const v of ["write-secret", "read-secret", "join-pw"]) expect(r.spec.compose).not.toContain(v);
    expect(r.secrets).toEqual({ "mumble-server": { MUMBLE_CONFIG_ICESECRETWRITE: "write-secret", MUMBLE_CONFIG_ICESECRETREAD: "read-secret", MUMBLE_CONFIG_SERVERPASSWORD: "join-pw" } });
  });

  it("never sets the admin password through the environment, which Mumble re-applies at every start", () => {
    expect(r.spec.compose).not.toContain("SUPERUSER");
    expect(JSON.stringify(r.secrets)).not.toContain("SUPERUSER");
  });

  it("keeps the welcome text exactly, with $ escaped for compose", () => {
    expect(svc.env.find((e) => e.key === "MUMBLE_CONFIG_WELCOMETEXT")?.value).toBe("Hi <b>all</b>, costs $0");
    expect(r.spec.compose).toContain("$$0");
  });

  it("leaves out an empty join password and welcome message", () => {
    const bare = voiceRecipe({ name: "x", welcome: "  ", password: "", port: 64738 }, secrets, 6502);
    expect(bare.secrets["mumble-server"]).not.toHaveProperty("MUMBLE_CONFIG_SERVERPASSWORD");
    expect(bare.spec.compose).not.toContain("WELCOMETEXT");
  });
});

describe("slugFor", () => {
  it.each([
    ["Friday Voice", "friday-voice"],
    ["  Café Ünïcode!! ", "cafe-unicode"],
    ["???", "mumble"],
    ["a".repeat(40), "a".repeat(30)],
  ])("%s → %s", (name, slug) => expect(slugFor(name)).toBe(slug));
});

describe("mumbleLink", () => {
  it("leaves out the default port and names the server", () => {
    expect(mumbleLink("voice.example.com", 64738, "Friday Voice")).toBe("mumble://voice.example.com/?version=1.2.0&title=Friday%20Voice");
  });
  it("keeps other ports and brackets IPv6", () => {
    expect(mumbleLink("fd00::1", 64739)).toBe("mumble://[fd00::1]:64739/?version=1.2.0");
  });
});
