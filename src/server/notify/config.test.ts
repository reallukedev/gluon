import { describe, expect, test } from "vitest";
import { maskConfig, mergeConfig, validateConfig } from "./config";

const ntfy = { server: "https://ntfy.home", topic: "gluon", token: "tk_secret", password: "pw" };

describe("editing a notification channel", () => {
  test("keeps secrets that weren't retyped while the destination stays put", () => {
    const masked = maskConfig("ntfy", ntfy).config;
    expect(mergeConfig("ntfy", ntfy, { ...masked, topic: "alerts" })).toMatchObject({ token: "tk_secret", password: "pw", topic: "alerts" });
  });

  test("drops kept secrets when the server changes, so they can't be sent somewhere new", () => {
    const masked = maskConfig("ntfy", ntfy).config;
    expect(mergeConfig("ntfy", ntfy, { ...masked, server: "https://attacker.example" })).toMatchObject({ server: "https://attacker.example", token: null, password: null });
  });

  test("a secret typed together with the new destination is kept", () => {
    expect(mergeConfig("ntfy", ntfy, { server: "https://ntfy.new", token: "tk_new" })).toMatchObject({ token: "tk_new", password: null });
  });

  test("a new email host loses the stored SMTP password; a new webhook URL loses header values", () => {
    expect(mergeConfig("email", { host: "smtp.home", port: 587, user: "me", pass: "smtp_pw" }, { host: "smtp.evil.example" })).toMatchObject({ pass: null });
    const hook = { url: "https://hooks.home/x", headers: [{ name: "Authorization", value: "Bearer abc" }] };
    const masked = maskConfig("webhook", hook).config as { headers: unknown };
    expect(mergeConfig("webhook", hook, { url: "https://evil.example/y", headers: masked.headers })).toMatchObject({ headers: [{ name: "Authorization", value: null }] });
  });
});

describe("XMPP channels", () => {
  const account = { mode: "account", jid: "alerts@chat.example.com", password: "hunter22", to: ["me@chat.example.com"] };

  test("the account password is never shown, not even its last characters", () => {
    const { config, secrets } = maskConfig("xmpp", { ...account, password: "a-long-password-1234" });
    expect(config.password).toBe("••••");
    expect(secrets.password).toBe(true);
  });

  test("a saved password is dropped when the account or its server changes", () => {
    const masked = maskConfig("xmpp", account).config;
    expect(mergeConfig("xmpp", account, { ...masked, jid: "someone@evil.example" })).toMatchObject({ password: null });
    expect(mergeConfig("xmpp", account, { ...masked, server: "evil.example:5222" })).toMatchObject({ password: null });
    expect(mergeConfig("xmpp", account, { ...masked, to: ["you@chat.example.com"] })).toMatchObject({ password: "hunter22" });
  });

  test.each([
    ["no one to send to", { ...account, to: [] }, "config.to"],
    ["an account with no password", { ...account, password: null }, "config.password"],
    ["sending to itself", { ...account, to: ["alerts@chat.example.com"] }, "config.to"],
    ["a server that isn't host:port", { ...account, server: "https://chat.example.com" }, "config.server"],
    ["this server's chat server, but no domain chosen", { mode: "server", app: "prosody", to: ["me@chat.example.com"] }, "config.domain"],
    ["an address that isn't one", { ...account, to: ["not an address"] }, "config.to.0"],
  ])("refuses %s", (_name, cfg, field) => {
    expect(() => validateConfig("xmpp", cfg)).toThrow(expect.objectContaining({ details: { field } }));
  });

  test("this server's chat server needs no account details, and stray ones aren't kept", () => {
    const c = validateConfig("xmpp", { mode: "server", app: "prosody", domain: "chat.example.com", to: ["Me@Chat.Example.com"], password: "left-over", jid: "x@y.z" });
    expect(c).toMatchObject({ to: ["me@chat.example.com"], password: null, jid: null, allowUntrusted: false });
  });
});
