import { describe, expect, it } from "vitest";
import { decideCopy, type CertInfo } from "../network/xmpp-cert-choice";
import { voiceReason } from "./cert-words";

const DAY = 86_400_000;
const now = Date.parse("2026-10-07T00:00:00Z");
const cert = (days: number, extra: Partial<CertInfo> = {}): CertInfo => ({ fingerprint: `fp${days}`, notAfter: now + days * DAY, covers: true, selfIssued: false, ...extra });

describe("voiceReason over the shared copy decision", () => {
  it.each([
    ["Mumble's own certificate is self-made", cert(80), cert(300, { selfIssued: true }), true],
    ["Mumble's certificate is about to expire", cert(80), cert(10), true],
    ["Mumble's certificate has a long time left", cert(80), cert(60), false],
    ["Mumble has Caddy's", cert(80), cert(80), false],
    ["Mumble has none", cert(80), null, true],
  ])("%s", (_, src, dst, copies) => {
    const d = decideCopy(src, dst, "voice.example.com", now);
    expect(d.copy).toBe(copies);
    const words = voiceReason(d.reason);
    expect(words).not.toMatch(/chat/i);
    expect(words).toMatch(/Mumble/);
  });
});
