import { describe, expect, it } from "vitest";
import { parseCompose, readService } from "@/lib/builder/compose";
import { editServiceEnv, manageCompose, mumbleService } from "./compose-edit";

const service = (text: string) => readService(parseCompose(text).doc, "mumble-server");

const MAP = `# my voice server
services:
  mumble-server:
    image: mumblevoip/mumble-server:latest
    ports:
      - "64738:64738"
      - "64738:64738/udp"
      - "6502:6502"
    environment:
      MUMBLE_CONFIG_WELCOMETEXT: hello # keep me
      MUMBLE_SUPERUSER_PASSWORD: hunter2
      MUMBLE_CONFIG_ICESECRETWRITE: old
`;

describe("manageCompose", () => {
  it("opens Ice on loopback only, with its secrets from a file, and keeps everything else", () => {
    const r = manageCompose(MAP, "mumble-server", { port: 6510, envFile: "gluon-voice.env" });
    const s = service(r.text);
    expect(s.ports.map((p) => `${p.ip}|${p.host}:${p.container}/${p.proto}`)).toEqual(["|64738:64738/tcp", "|64738:64738/udp", "127.0.0.1|6510:6502/tcp"]);
    expect(s.env).toEqual([
      { key: "MUMBLE_CONFIG_WELCOMETEXT", value: "hello", interpolated: false },
      { key: "MUMBLE_CONFIG_ICE", value: "tcp -h 0.0.0.0 -p 6502", interpolated: false },
    ]);
    expect(r.removed.sort()).toEqual(["MUMBLE_CONFIG_ICESECRETWRITE", "MUMBLE_SUPERUSER_PASSWORD"]);
    expect(r.text).toContain("# my voice server");
    expect(r.text).toContain("# keep me");
    expect(parseCompose(r.text).doc.toJS().services["mumble-server"].env_file).toEqual(["gluon-voice.env"]);
  });

  it("is safe to run twice", () => {
    const once = manageCompose(MAP, "mumble-server", { port: 6510, envFile: "gluon-voice.env" }).text;
    expect(manageCompose(once, "mumble-server", { port: 6510, envFile: "gluon-voice.env" }).text).toBe(once);
  });

  it("edits a KEY=value environment list in place and adds to an existing env_file", () => {
    const list = `services:
  mumble-server:
    image: mumblevoip/mumble-server
    env_file: other.env
    environment:
      - MUMBLE_CONFIG_PORT=64738
      - MUMBLE_SUPERUSER_PASSWORD=x
`;
    const r = manageCompose(list, "mumble-server", { port: 6502, envFile: "gluon-voice.env" });
    const js = parseCompose(r.text).doc.toJS().services["mumble-server"];
    expect(js.environment).toEqual(["MUMBLE_CONFIG_PORT=64738", "MUMBLE_CONFIG_ICE=tcp -h 0.0.0.0 -p 6502"]);
    expect(js.env_file).toEqual(["other.env", "gluon-voice.env"]);
  });

  it("on the host's network, binds Ice to loopback itself and publishes nothing", () => {
    const host = `services:
  mumble-server:
    image: mumblevoip/mumble-server
    network_mode: host
`;
    const r = manageCompose(host, "mumble-server", { port: 6505, envFile: null });
    const js = parseCompose(r.text).doc.toJS().services["mumble-server"];
    expect(js.environment).toEqual({ MUMBLE_CONFIG_ICE: "tcp -h 127.0.0.1 -p 6505" });
    expect(js.ports).toBeUndefined();
    expect(js.env_file).toBeUndefined();
  });

  it("refuses a file it can't parse rather than guessing", () => {
    expect(() => manageCompose("services: [", "mumble-server", { port: 6502, envFile: null })).toThrow(/errors/);
  });
});

describe("editServiceEnv", () => {
  it("removes one variable and drops an environment left empty", () => {
    const text = `services:
  mumble-server:
    image: mumblevoip/mumble-server
    environment:
      MUMBLE_CONFIG_SERVERPASSWORD: pw
`;
    const r = editServiceEnv(text, "mumble-server", { remove: (k) => k === "MUMBLE_CONFIG_SERVERPASSWORD" });
    expect(r.removed).toEqual(["MUMBLE_CONFIG_SERVERPASSWORD"]);
    expect(parseCompose(r.text).doc.toJS().services["mumble-server"].environment).toBeUndefined();
  });
});

describe("mumbleService", () => {
  it("finds the Mumble service among others", () => {
    expect(mumbleService("services:\n  web:\n    image: nginx\n  voice:\n    image: mumblevoip/mumble-server:v1.5.915\n")).toBe("voice");
    expect(mumbleService("services:\n  web:\n    image: nginx\n")).toBeNull();
  });
});
