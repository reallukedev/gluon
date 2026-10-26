import { describe, expect, it } from "vitest";
import { prepare } from "@/lib/search-match";
import type { SearchEvent, SearchGroupOut } from "@/lib/search-types";
import { beginStream, buildSections, CLEAR_RECENT, flatten, reduceStream, type StaticGroup, type StreamState } from "./paletteModel";

const group = (key: string, name: string, items: [string, string, number][], extra: Partial<SearchGroupOut> = {}): SearchEvent => ({
  type: "group",
  group: { key, name, tier: "local", priority: 50, items: items.map(([id, label, score]) => ({ id, label, score, href: `/${id}` })), ...extra },
});

const play = (events: SearchEvent[], from: StreamState | null = null, term = "jelly", scope = "all") => events.reduce(reduceStream, beginStream(from, term, scope));

const statics: StaticGroup[] = [
  { key: "nav", name: "Go to", priority: 16, idle: true, items: [{ id: "nav:apps", label: "Apps", href: "/apps" }, { id: "nav:files", label: "Files", href: "/files" }] },
  { key: "settings", name: "Settings", priority: 18, items: [{ id: "settings:appearance", label: "Appearance", keywords: "theme dark", href: "/settings/appearance" }, { id: "settings:notifications", label: "Notifications", hint: "Settings", href: "/settings/notifications" }] },
];

const build = (term: string, stream: StreamState | null, o: { scope?: string; recent?: string[] } = {}) =>
  buildSections({ query: prepare(term), scope: o.scope ?? "all", statics, stream, recent: o.recent ?? [], perGroup: 5 });

describe("the streamed state", () => {
  it("keeps the previous answer on screen until this query's groups arrive, then drops what wasn't refreshed", () => {
    const first = play([{ type: "start", pending: [] }, group("apps", "Apps", [["app:j", "Jellyfin", 0.9]]), group("docker", "Docker", [["img:j", "jellyfin/jellyfin", 0.8]]), { type: "done", ms: 5 }]);
    let next = beginStream(first, "jellyf", "all");
    expect(next.groups.map((g) => [g.key, g.stale])).toEqual([["apps", true], ["docker", true]]);
    next = reduceStream(next, group("apps", "Apps", [["app:j", "Jellyfin", 0.95]]));
    expect(next.groups.map((g) => [g.key, !!g.stale])).toEqual([["apps", false], ["docker", true]]);
    next = reduceStream(next, { type: "done", ms: 5 });
    expect(next.groups.map((g) => g.key)).toEqual(["apps"]);
  });

  it("starts empty when the scope changes", () => {
    const first = play([group("apps", "Apps", [["app:j", "Jellyfin", 0.9]])]);
    expect(beginStream(first, "jelly", "files").groups).toEqual([]);
  });
});

describe("sections", () => {
  it("lifts the best match to the top and shows it once", () => {
    const s = build("jellyfin", play([group("apps", "Apps", [["app:j", "Jellyfin", 1], ["app:jv", "Jellyfin Vue", 0.9]])], null, "jellyfin"));
    expect(s[0]).toMatchObject({ name: "Best match", items: [{ id: "app:j" }] });
    expect(s.find((x) => x.name === "Apps")!.items.map((i) => i.id)).toEqual(["app:jv"]);
  });

  it("puts groups with strong matches before weak ones, then in their usual order", () => {
    const stream = play([group("people", "People", [["p:1", "Appleby", 0.5]], { priority: 50 }), group("system", "System", [["sys:apps", "Applications", 0.86]], { priority: 45 })], null, "app");
    // "Apps" (Go to, static, exact-ish) and System are strong; People is weak and comes last.
    const names = build("app", stream).map((x) => x.name);
    expect(names.indexOf("People")).toBe(names.length - 1);
    expect(names.indexOf("Go to")).toBeLessThan(names.indexOf("System"));
  });

  it("keeps connected apps in the order they were asked, loading or failed in place", () => {
    let s = play([{ type: "start", pending: [{ key: "app:a", name: "Jellyfin", tier: "app" }, { key: "app:b", name: "Immich", tier: "app" }, { key: "app:c", name: "Music", tier: "app" }] }]);
    s = reduceStream(s, { type: "group", group: { key: "app:c", name: "Music", tier: "app", priority: 80, items: [{ id: "song", label: "Jelly Roll", score: 0.5 }] } });
    s = reduceStream(s, { type: "fail", key: "app:b", name: "Immich", tier: "app", message: "Immich didn't answer in time.", timedOut: true });
    const apps = build("jelly", s).filter((x) => x.tier === "app");
    expect(apps.map((x) => [x.name, !!x.loading, x.error ?? null, x.items.length])).toEqual([
      ["Jellyfin", true, null, 0],
      ["Immich", false, "Immich didn't answer in time.", 0],
      ["Music", false, null, 1],
    ]);
  });

  it("filters a stale group by what's typed now", () => {
    const first = play([group("apps", "Apps", [["app:j", "Jellyfin", 0.9], ["app:i", "Immich", 0.4]]), { type: "done", ms: 1 }], null, "i");
    const s = build("jel", beginStream(first, "jel", "all"));
    expect(flatten(s).map((i) => i.id)).toContain("app:j");
    expect(flatten(s).map((i) => i.id)).not.toContain("app:i");
  });

  it("shows recent searches and the idle groups when nothing is typed", () => {
    const s = build("", null, { recent: ["dune", "disk"] });
    expect(s.map((x) => x.name)).toEqual(["Recent searches", "Go to"]);
    expect(s[0]!.items[0]).toMatchObject({ label: "dune", fill: "dune" });
    // Clearing them is a result too, so the keyboard reaches it.
    expect(s[0]!.items.at(-1)).toMatchObject({ id: CLEAR_RECENT, label: "Clear recent searches" });
  });

  it("goes to a place named after \"go to\" or \"settings\"", () => {
    expect(build("go to notifications", null).find((x) => x.best)!.items[0]!.id).toBe("settings:notifications");
    expect(build("settings appearance", null).find((x) => x.best)!.items[0]!.id).toBe("settings:appearance");
  });

  it("only shows the palette's own entries when searching everywhere", () => {
    const s = build("appearance", play([], null, "appearance", "files"), { scope: "files" });
    expect(flatten(s)).toEqual([]);
  });
});
