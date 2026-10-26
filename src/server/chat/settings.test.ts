import { describe, expect, it } from "vitest";
import type { ChatSettings } from "@/lib/chat-types";
import { type RenderContext, componentChange, durationDays, hasInclude, historyFrom, readGluonConfig, renderGluonConfig, signUpFrom, withInclude } from "./settings";

const base: ChatSettings = {
  signUp: "closed",
  history: "3m",
  groups: { on: false, host: "rooms.chat.example.com", whoCreates: "everyone" },
  files: { on: false, host: "upload.chat.example.com", maxMb: 100, keepDays: 30 },
  push: false,
  federation: true,
  web: false,
  welcome: null,
  contact: null,
};
const ctx: RenderContext = { host: "chat.example.com", ownComponents: { muc: null, files: null }, publicBase: null };
const render = (s: Partial<ChatSettings>, c: Partial<RenderContext> = {}) => renderGluonConfig({ ...base, ...s }, { ...ctx, ...c });

describe("renderGluonConfig", () => {
  it("returns to the global section before setting anything, so it can sit after the person's VirtualHosts", () => {
    const lines = render({}).split("\n").filter((l) => l && !l.startsWith("--"));
    expect(lines[0]).toBe('Host "*"');
  });

  it("maps who can sign up onto Prosody's two registration options", () => {
    expect(render({ signUp: "closed" })).toMatch(/^allow_registration = false$/m);
    expect(render({ signUp: "closed" })).not.toMatch(/registration_invite_only/);
    expect(render({ signUp: "invite" })).toMatch(/^allow_registration = true\nregistration_invite_only = true$/m);
    expect(render({ signUp: "open" })).toMatch(/^registration_invite_only = false$/m);
  });

  it("keeps a welcome message with quotes and line breaks inside its string", () => {
    const out = render({ welcome: 'Hi "you"\nend\nmodules_enabled = {}' });
    const line = out.split("\n").find((l) => l.startsWith("welcome_message"))!;
    expect(line).toBe('welcome_message = "Hi \\"you\\"\\nend\\nmodules_enabled = {}"');
    expect(out).not.toMatch(/^modules_enabled = \{\}/m);
  });

  it("turns history off by disabling the archive, and leaves a hand-set expiry alone", () => {
    expect(render({ history: "off" })).toMatch(/^if modules_disabled then modules_disabled:append \{ [^}]*"mam"/m);
    expect(render({ history: "custom" })).not.toMatch(/archive_expires_after/);
  });

  // Prosody's strict period grammar (util/human/io.lua parse_duration): a number, optional space,
  // and a unit it can't mistake. "1m" parses only through its lenient fallback, as ambiguous.
  it("writes history lengths Prosody reads without guessing", () => {
    const strict = /^\d+ ?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/;
    for (const h of ["1w", "1m", "3m", "1y", "never"] as const) {
      const v = render({ history: h }).match(/^archive_expires_after = "(.+)"$/m)![1]!;
      expect(v === "never" || strict.test(v)).toBe(true);
      // And Gluon reads its own value back as the same choice.
      expect(historyFrom(true, v)).toBe(h);
    }
  });

  it("only ever writes the room-creation values mod_muc understands", () => {
    // Anything other than true, false or "local" falls back to no restriction at all.
    const groups = (whoCreates: "everyone" | "admins") => render({ groups: { ...base.groups, on: true, whoCreates } }).match(/restrict_room_creation = (.+)$/m)![1];
    expect(groups("admins")).toBe("true");
    expect(groups("everyone")).toBe('"local"');
  });

  it("adds to the module lists whether or not the config set them (the official image sets modules_disabled to nil)", () => {
    const out = render({ history: "off" });
    expect(out).toMatch(/^if modules_enabled then modules_enabled:append \{ [^}]+ \} else modules_enabled = \{ [^}]+ \} end$/m);
    expect(out).toMatch(/^if modules_disabled then modules_disabled:append \{ [^}]+ \} else modules_disabled = \{ [^}]+ \} end$/m);
  });

  it("turns switched-off features off even when the person's own config enables them", () => {
    const out = render({ push: false, web: false });
    expect(out).toMatch(/^if modules_disabled then modules_disabled:append \{ [^}]*"cloud_notify"/m);
    expect(out).toMatch(/^if modules_disabled then modules_disabled:append \{ [^}]*"bosh"[^}]*"websocket"/m);
  });

  it("in the installer's layout, includes the person's file last so their settings win", () => {
    const out = render({}, { layout: "confd" });
    const lines = out.trimEnd().split("\n");
    expect(lines.at(-1)).toBe('Include "/etc/prosody/conf.d/custom.lua"');
    expect(lines.at(-2)).toBe('Host "*"');
  });

  it("declares group chat and file services only when they aren't already in the person's config", () => {
    const on = { groups: { ...base.groups, on: true }, files: { ...base.files, on: true } };
    expect(render(on)).toMatch(/^Component "rooms\.chat\.example\.com" "muc"$/m);
    expect(render(on)).toMatch(/^Component "upload\.chat\.example\.com" "http_file_share"$/m);
    const own = render(on, { ownComponents: { muc: "conference.chat.example.com", files: "share.chat.example.com" } });
    expect(own).not.toMatch(/^Component/m);
  });

  it("serves uploads at the chat domain, where Caddy forwards them", () => {
    const out = render({ files: { ...base.files, on: true, maxMb: 50 } });
    expect(out).toMatch(/^http_external_url = "https:\/\/chat\.example\.com\/"$/m);
    expect(out).toMatch(/^\thttp_host = "chat\.example\.com"$/m);
    expect(out).toMatch(/^\thttp_file_share_size_limit = 52428800$/m);
    // Caddy reaches the chat server from outside its container, and only Docker's bridges may
    // vouch that a request was HTTPS: never the home network, which could talk plain HTTP.
    expect(out).toMatch(/^http_interfaces = \{ "\*"; "::" \}$/m);
    expect(out).not.toMatch(/consider_(bosh|websocket)_secure/);
    expect(out).not.toMatch(/trusted_proxies = [^\n]*192\.168/);
  });

  it("gives chat apps the call relay without putting its secret in the config", () => {
    const on = render({ calls: { on: true, host: "chat.example.com" } });
    expect(on).toMatch(/^turn_external_host = "chat\.example\.com"$/m);
    expect(on).toMatch(/^turn_external_port = 3478$/m);
    expect(on).toMatch(/turn_external_secret = f:read/);
    expect(on).not.toMatch(/turn_external_secret = "/);
    expect(render({ calls: { on: false, host: "chat.example.com" } })).toMatch(/modules_disabled[^\n]*"turn_external"/);
  });

  it("points invite links at Gluon's page only when Gluon has a public address", () => {
    expect(render({})).not.toMatch(/invites_page/);
    expect(render({}, { publicBase: "https://server.example.com" })).toMatch(/^invites_page = "https:\/\/server\.example\.com\/chat-invite\/\{host\}\/\{invite\.token\}"$/m);
  });

  it("can be read back from its own marker line", () => {
    const s: ChatSettings = { ...base, signUp: "invite", push: true, welcome: "hi", contact: "me@chat.example.com" };
    expect(readGluonConfig(renderGluonConfig(s, ctx))).toEqual(s);
    expect(readGluonConfig("allow_registration = true\n")).toBeNull();
  });
});

describe("reading Prosody's own values", () => {
  it("understands the duration forms Prosody accepts", () => {
    expect(durationDays("1w")).toBe(7);
    expect(durationDays("3 months")).toBe(90);
    expect(durationDays(86_400)).toBe(1);
    expect(durationDays("never")).toBe(Infinity);
    expect(durationDays("soon")).toBeNull();
  });

  it("names the closest history choice, Prosody's default when unset, and custom values", () => {
    expect(historyFrom(true, "3 months")).toBe("3m");
    expect(historyFrom(true, undefined)).toBe("1w");
    expect(historyFrom(true, "never")).toBe("never");
    expect(historyFrom(true, "45d")).toBe("custom");
    expect(historyFrom(false, "1y")).toBe("off");
  });

  it("reads sign-up the way mod_invites_register behaves", () => {
    expect(signUpFrom(false, true, true)).toBe("closed");
    expect(signUpFrom(true, undefined, true)).toBe("invite");
    expect(signUpFrom(true, undefined, false)).toBe("open");
    expect(signUpFrom(true, false, true)).toBe("open");
  });
});

describe("the Include line", () => {
  it("is added once, at the end", () => {
    const main = 'admins = {}\nVirtualHost "chat.example.com"\n';
    const once = withInclude(main);
    expect(once.changed).toBe(true);
    expect(once.text.trimEnd().endsWith('Include "gluon.cfg.lua"')).toBe(true);
    expect(withInclude(once.text)).toEqual({ text: once.text, changed: false });
  });

  it("doesn't count a commented-out Include", () => {
    expect(hasInclude('-- Include "gluon.cfg.lua"\n')).toBe(false);
    expect(hasInclude("Include('gluon.cfg.lua');\n")).toBe(true);
  });
});

describe("componentChange", () => {
  it("asks for a restart when a service Gluon declares comes or goes, not for its own options", () => {
    const own = { muc: null, files: null };
    expect(componentChange(base, { ...base, groups: { ...base.groups, on: true } }, own)).toEqual(["group chats"]);
    expect(componentChange({ ...base, files: { ...base.files, on: true } }, base, own)).toEqual(["removing file sharing"]);
    expect(componentChange(base, { ...base, groups: { ...base.groups, whoCreates: "admins" } }, own)).toEqual([]);
    expect(componentChange(base, { ...base, web: true }, own)).toEqual(["web chat"]);
    expect(componentChange(base, { ...base, groups: { ...base.groups, on: true } }, { muc: "conference.chat.example.com", files: null })).toEqual([]);
  });
});
