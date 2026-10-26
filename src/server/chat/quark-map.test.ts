import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { ctlValue, parseCtl, quarkSnapshot, settingsRev, toQuarkSettings, type QuarkSnapshot } from "./quark-map";
import { installSettings } from "./recipe";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
const raw = (): QuarkSnapshot => JSON.parse(fixture("quark-snapshot.json"));
const ctx = { app: { id: "quark", name: "Quark" }, container: "quark-quark-1", route: { host: "chat.example.com", httpPort: 5280 }, publicBase: "https://home.example.com", now: 1 };

const thrown = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error("didn't throw");
};

describe("reading quark ctl", () => {
  it("takes the answer line and ignores anything logged before it", () => {
    const r = parseCtl(fixture("quark-ctl-ok.txt"), "", 0);
    expect(r).toEqual({ kind: "ok", value: expect.objectContaining({ server: "quark", version: "0.1.0" }) });
  });

  it("shows Quark's refusal as it is, with the status its code calls for", () => {
    const e = thrown(() => ctlValue(parseCtl(fixture("quark-ctl-refused.txt"), "", 0)));
    expect(e).toBeInstanceOf(AppError);
    expect(e.message).toBe("There's already an account called sam@chat.example.com.");
    expect([e.code, e.status]).toEqual(["exists", 409]);
    const status = (code: string) => thrown(() => ctlValue({ kind: "refused", code, error: "x" })).status;
    expect([status("not_found"), status("config"), status("invalid"), status("not_enabled")]).toEqual([404, 409, 400, 400]);
  });

  it("says it couldn't reach the admin console when nothing answered", () => {
    const r = parseCtl("", fixture("quark-ctl-unreachable.txt"), 1);
    expect(r.kind).toBe("unreachable");
    const e = thrown(() => ctlValue(r));
    expect(e.code).toBe("quark_console");
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/^Couldn't reach Quark's admin console \(.*admin\.sock/);
    // An exec that never started (no quark binary) prints no JSON at all.
    expect(parseCtl('OCI runtime exec failed: exec: "quark": executable file not found', "", 126).kind).toBe("unreachable");
  });

  it("doesn't take a JSON line that isn't an answer", () => {
    expect(parseCtl('{"level":"info","msg":"hi"}\n', "", 1).kind).toBe("unreachable");
  });
});

describe("Quark's snapshot", () => {
  const snap = quarkSnapshot(raw(), ctx);
  const host = snap.hosts[0]!;

  it("puts the domain on Network first, whatever order Quark lists them in", () => {
    expect(snap.hosts.map((h) => h.host)).toEqual(["chat.example.com", "other.example.org"]);
    expect(snap.routeHost).toBe("chat.example.com");
  });

  it("says it's Quark, with no Prosody version rules and its built-in relay", () => {
    expect(snap.server).toBe("quark");
    expect(snap.major).toBeNull();
    expect(snap.version).toBe("0.1.0");
    expect(snap.builtInRelay).toEqual({ builtIn: true, running: true, port: 3478, relayMin: 49160, relayMax: 49200 });
    expect(snap.config).toMatchObject({ file: "/etc/quark/quark.toml", hostPath: null, writable: true });
  });

  it("makes accounts listed in the config file owners, and marks Gluon's sender", () => {
    const by = Object.fromEntries(host.accounts.map((a) => [a.user, a]));
    expect(by.luke).toMatchObject({ jid: "luke@chat.example.com", role: "owner", fromConfig: true });
    expect(by.sam).toMatchObject({ role: "admin", fromConfig: false, sender: false });
    expect(by.gluon!.sender).toBe(true);
    expect(by.old!.enabled).toBe(false);
    expect(host.accounts.map((a) => a.user)).toEqual(["gluon", "luke", "old", "sam"]);
  });

  it("names chat apps Quark didn't, newest device first", () => {
    const devices = host.accounts.find((a) => a.user === "luke")!.devices;
    expect(devices.map((d) => [d.resource, d.client])).toEqual([
      ["Conversations.Qqth", "Conversations"],
      ["Gajim.x1", "Gajim"],
    ]);
  });

  it("sends invites without a page of Quark's own to Gluon's invite page", () => {
    const [newest, older] = host.invites;
    expect(newest).toMatchObject({ token: "bbbbbbbbbbbb", username: "jo", role: "admin", page: "https://chat.example.com/invite/bbbbbbbbbbbb" });
    expect(older).toMatchObject({ token: "aaaaaaaaaaaa", reusable: true, page: "https://home.example.com/chat-invite/chat.example.com/aaaaaaaaaaaa" });
    expect(host.invitesReady).toBe(true);
    const noBase = quarkSnapshot(raw(), { ...ctx, publicBase: null }).hosts[0]!.invites.find((i) => i.token === "aaaaaaaaaaaa")!;
    expect(noBase.page).toBeNull();
  });

  it("lists the busiest group chat first", () => {
    expect(host.rooms.map((r) => r.jid)).toEqual(["family@rooms.chat.example.com", "quiet@rooms.chat.example.com"]);
    expect(host.rooms[1]).toMatchObject({ membersOnly: true, public: false, description: null });
  });

  it("works out what chat apps can do from Quark's module names", () => {
    const caps = Object.fromEntries(host.capabilities.map((c) => [c.key, c.on]));
    expect(caps).toMatchObject({ secure: true, history: true, devices: true, mobile: true, push: true, files: true, groups: true, federation: true, invites: true, calls: true, contact: true });
    // The other domain has no web address on Network and few features, and Quark's advice is Quark's.
    const other = snap.hosts[1]!;
    expect(other.capabilities.find((c) => c.key === "files")!.on).toBe(false);
    expect(other.capabilities.find((c) => c.key === "devices")!.detail).toMatch(/Quark/);
    expect(other.capabilities.find((c) => c.key === "devices")!.detail).not.toMatch(/modules_enabled/);
  });

  it("only counts uploads as working when the web address reaches Quark", () => {
    const noWeb = quarkSnapshot(raw(), { ...ctx, route: { host: "chat.example.com", httpPort: null } });
    expect(noWeb.hosts[0]!.capabilities.find((c) => c.key === "files")!.on).toBe(false);
  });

  it("changes its revision when any domain's settings change, and only then", () => {
    const changed = raw();
    changed.hosts[1]!.settings.push = false;
    const moved = raw();
    moved.hosts.reverse();
    moved.stats.c2s = 9;
    expect(quarkSnapshot(moved, ctx).config.rev).toBe(snap.config.rev);
    expect(quarkSnapshot(changed, ctx).config.rev).not.toBe(snap.config.rev);
    expect(settingsRev([])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("copes with a domain Quark sends without lists", () => {
    const thin = raw();
    const h = thin.hosts[0]! as unknown as Record<string, unknown>;
    delete h.accounts;
    delete h.invites;
    delete h.rooms;
    delete h.admins;
    const s = quarkSnapshot(thin, ctx).hosts.find((x) => x.host === "other.example.org")!;
    expect([s.accounts, s.invites, s.rooms]).toEqual([[], [], []]);
  });
});

describe("settings for Quark", () => {
  const current = installSettings("chat.example.com");

  it("keeps Quark's history when a page sends the hand-set value only Prosody has", () => {
    expect(toQuarkSettings({ ...current, history: "custom" }, current, "chat.example.com").history).toBe("3m");
    expect(toQuarkSettings({ ...current, history: "custom" }, { ...current, history: "custom" }, "chat.example.com").history).toBe("1w");
    expect(toQuarkSettings({ ...current, history: "1y" }, current, "chat.example.com").history).toBe("1y");
  });

  it("always sends calls, which Quark requires", () => {
    const { calls: _drop, ...old } = current;
    expect(toQuarkSettings(old, old, "chat.example.com").calls).toEqual({ on: false, host: "chat.example.com" });
    expect(toQuarkSettings(old, current, "chat.example.com").calls).toEqual(current.calls);
  });
});
