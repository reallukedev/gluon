import { describe, expect, test } from "vitest";
import { maskConfig, mergeConfig } from "./config";

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
