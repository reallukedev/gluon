import { describe, expect, it } from "vitest";
import type { ChatSettings } from "@/lib/chat-types";
import { capabilities } from "./capabilities";

const settings: ChatSettings = {
  signUp: "invite",
  history: "1m",
  groups: { on: false, host: "rooms.chat.example.com", whoCreates: "everyone" },
  files: { on: true, host: "upload.chat.example.com", maxMb: 100, keepDays: 30 },
  push: false,
  federation: true,
  web: false,
  welcome: null,
  contact: null,
};
const caps = (modules: string[], over: Partial<Parameters<typeof capabilities>[0]> = {}) =>
  Object.fromEntries(
    capabilities({ host: "chat.example.com", modules: new Set(modules), groupsHost: null, filesHost: "upload.chat.example.com", webSide: false, settings, requireEncryption: true, ...over }).map((c) => [c.key, c]),
  );

describe("capabilities", () => {
  it("doesn't call file sharing working until the chat domain's web address reaches the chat server", () => {
    expect(caps([]).files!.on).toBe(false);
    expect(caps([]).files!.detail).toMatch(/uploads fail/);
    expect(caps([], { webSide: true }).files!.on).toBe(true);
  });

  it("only counts encrypted sign-in when Prosody refuses plain connections", () => {
    expect(caps(["tls", "saslauth"]).secure!.on).toBe(true);
    expect(caps(["tls", "saslauth"], { requireEncryption: false }).secure!.on).toBe(false);
  });
});
