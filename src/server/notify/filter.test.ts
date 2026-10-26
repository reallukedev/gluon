import { describe, expect, test } from "vitest";
import { normalizeFilter, presetOf, subscriptionFilterSchema, PROBLEM_KINDS } from "@/lib/alerts-types";
import { wantsEvent, wantsFinding } from "./filter";

const parse = (raw: unknown) => normalizeFilter(subscriptionFilterSchema.parse(raw));

type F = { kind: string; severity: string; subject: string | null };
const broken: F = { kind: "app.broken", severity: "fault", subject: "jellyfin" };
const lowSpace = { kind: "disk.space", severity: "attention", subject: null };
const newDevice = { kind: "signin.new_device", severity: "attention", subject: "luke" };
const report = { kind: "household.report", severity: "attention", subject: "immich" };
const updateInfo = { kind: "gluon-update", severity: "info", subject: "gluon" };

describe("subscriptions saved before notification kinds existed", () => {
  // Each old filter, and what it was getting (the old rules, written out by hand).
  const cases: { name: string; raw: Record<string, unknown>; gets: F[]; skips: F[] }[] = [
    { name: "the old default (everything)", raw: {}, gets: [broken, lowSpace, newDevice, report], skips: [updateInfo] },
    { name: "faults only", raw: { severities: ["fault"] }, gets: [broken, report], skips: [lowSpace, newDevice] },
    { name: "one app, both severities", raw: { subjects: ["jellyfin"] }, gets: [broken, report], skips: [lowSpace, newDevice] },
    { name: "reports turned off", raw: { reports: false }, gets: [broken, newDevice], skips: [report] },
  ];
  for (const c of cases) {
    test(`${c.name} keeps getting exactly what it got`, () => {
      const f = parse(c.raw);
      for (const x of c.gets) expect(wantsFinding("admin", f, x, null), `${x.kind}`).toBe(true);
      for (const x of c.skips) expect(wantsFinding("admin", f, x, null), `${x.kind}`).toBe(false);
    });
  }

  test("none of the new kinds (updates, chat, two-step off) are switched on for them", () => {
    const f = parse({ digest: true });
    for (const k of ["gluon.available", "gluon.installed", "gluon.failed", "app.available", "app.updated", "mfa.off", "chat.joined"] as const) {
      expect(wantsEvent("admin", f, { kind: k, subject: "jellyfin" }, null), k).toBe(false);
    }
    expect(f.kinds).toContain("digest");
  });

  test("the old fields follow the kinds once kinds are saved, so older code reads the same answer", () => {
    const f = parse({ kinds: ["fault", "app.updated"], severities: ["fault", "attention"], resolved: true, reports: true });
    expect(f).toMatchObject({ severities: ["fault"], resolved: false, reports: false, digest: false });
  });
});

describe("choosing kinds per channel", () => {
  test("new subscriptions start on problems only, which the quick choice recognises", () => {
    expect(presetOf(PROBLEM_KINDS, "admin")).toBe("problems");
    expect(presetOf(parse({}).kinds, "admin")).toBe("custom");
  });

  test("only some apps narrows app updates but not sign-in or Gluon alerts", () => {
    const f = parse({ kinds: ["app.available", "signin.new_device", "gluon.failed"], subjects: ["immich"] });
    expect(wantsEvent("admin", f, { kind: "app.available", subject: "jellyfin" }, null)).toBe(false);
    expect(wantsEvent("admin", f, { kind: "app.available", subject: "immich" }, null)).toBe(true);
    expect(wantsFinding("admin", f, newDevice, null)).toBe(true);
    expect(wantsEvent("admin", f, { kind: "gluon.failed" }, null)).toBe(true);
  });

  test("household members never hear about apps they can't see, or about anything that isn't their apps", () => {
    const f = parse({ kinds: ["fault", "app.updated", "mfa.off", "gluon.installed"] });
    const theirs = new Set(["immich"]);
    expect(wantsEvent("member", f, { kind: "app.updated", subject: "jellyfin" }, theirs)).toBe(false);
    expect(wantsEvent("member", f, { kind: "app.updated", subject: "immich" }, theirs)).toBe(true);
    expect(wantsEvent("member", f, { kind: "mfa.off" }, theirs)).toBe(false);
    expect(wantsEvent("member", f, { kind: "gluon.installed" }, theirs)).toBe(false);
    expect(wantsFinding("member", f, lowSpace, theirs)).toBe(false);
    expect(wantsFinding("member", f, { ...broken, subject: "immich" }, theirs)).toBe(true);
  });
});
