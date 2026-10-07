import { describe, expect, it } from "vitest";
import { effectiveSettings, envFor, settingDef, toStored } from "./settings-map";

const pick = (list: ReturnType<typeof effectiveSettings>, key: string) => list.find((s) => s.key === key)!;

describe("effectiveSettings", () => {
  it("prefers a value saved over Ice to the config file, and says where each comes from", () => {
    const list = effectiveSettings({
      db: { welcometext: "From Gluon", users: "" },
      defaults: { welcometext: "From the file", users: "50", password: "" },
      env: { MUMBLE_CONFIG_WELCOMETEXT: "From the file", MUMBLE_CONFIG_USERS: "50" },
    });
    expect(pick(list, "welcometext")).toMatchObject({ value: "From Gluon", source: "gluon", envName: "MUMBLE_CONFIG_WELCOMETEXT", envValue: "From the file" });
    // An empty saved value means "not set": Mumble falls back to the file.
    expect(pick(list, "users")).toMatchObject({ value: "50", source: "compose" });
    expect(pick(list, "password")).toMatchObject({ value: "", source: "default" });
  });

  it("works without Ice, from the container's environment alone", () => {
    const list = effectiveSettings({ db: {}, defaults: {}, env: { MUMBLE_CONFIG_SERVER_PASSWORD: '"secret"', MUMBLE_CONFIG_ALLOW_HTML: "false" } });
    expect(pick(list, "password")).toMatchObject({ value: "secret", source: "compose", envName: "MUMBLE_CONFIG_SERVER_PASSWORD" });
    expect(pick(list, "allowhtml")).toMatchObject({ value: "false", source: "compose" });
    expect(pick(list, "bandwidth")).toMatchObject({ value: "558000", source: "default" });
  });
});

describe("envFor", () => {
  it("matches variables the way the image's entrypoint does: case and underscores don't matter", () => {
    expect(envFor("registerName", { MUMBLE_CONFIG_REGISTER_NAME: "x" })).toEqual({ name: "MUMBLE_CONFIG_REGISTER_NAME", value: "x" });
    expect(envFor("ice", { MUMBLE_CONFIG_ICESECRETWRITE: "s" })).toBeNull();
  });
});

describe("toStored", () => {
  it("converts shown units to Mumble's", () => {
    expect(toStored(settingDef("bandwidth")!, "72")).toEqual({ ok: true, value: "72000" });
    expect(toStored(settingDef("imagemessagelength")!, "128")).toEqual({ ok: true, value: "131072" });
  });
  it.each([
    ["users", "0", false],
    ["users", "12.5", false],
    ["users", "25", true],
    ["allowhtml", "yes", false],
    ["allowhtml", "false", true],
    ["registername", "two\nlines", false],
    ["welcometext", "two\nlines", true],
  ])("%s = %j → ok %s", (key, raw, ok) => expect(toStored(settingDef(key)!, raw).ok).toBe(ok));
});
