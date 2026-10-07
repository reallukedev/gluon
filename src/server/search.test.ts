import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSearchCache, registerSearch, runSearch, type ProviderDef } from "./search";
import { AppError } from "./errors";
import type { SearchEvent } from "@/lib/search-types";
import type { User } from "./auth/users";

const admin = { id: "u1", username: "luke", role: "admin" } as User;
const member = { id: "u2", username: "sam", role: "member" } as User;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

/** Run a search with only these providers (on top of whatever the modules registered: none in tests). */
async function collect(user: User, q: string, extra: ProviderDef[], o: { scope?: string; signal?: AbortSignal; noCache?: boolean; grants?: string } = {}) {
  const events: (SearchEvent & { t: number })[] = [];
  const t0 = Date.now();
  await runSearch(user, q, { scope: o.scope ?? "all", zone: "home", signal: o.signal ?? new AbortController().signal, extra, noCache: o.noCache ?? true, grants: o.grants, emit: (e) => events.push({ ...e, t: Date.now() - t0 }) });
  return events;
}

const fast: ProviderDef = { key: "fast", name: "Apps", priority: 10, run: () => [{ id: "app:jellyfin", label: "Jellyfin", href: "/apps/jellyfin" }] };
const slowApp: ProviderDef = {
  key: "app:immich",
  name: "Immich",
  tier: "app",
  budgetMs: 60,
  run: async (_u, _q, ctx) => {
    await sleep(1000, ctx.signal);
    return [];
  },
};

afterEach(() => {
  clearSearchCache();
  vi.useRealTimers();
});

describe("runSearch", () => {
  it("streams fast groups before a slow app answers, and says the slow app timed out", async () => {
    const events = await collect(admin, "jelly", [fast, slowApp]);
    expect(events[0]).toMatchObject({ type: "start", pending: [{ key: "app:immich", name: "Immich", tier: "app" }] });
    const group = events.find((e) => e.type === "group")!;
    const fail = events.find((e) => e.type === "fail")!;
    expect(group).toMatchObject({ group: { key: "fast", name: "Apps", items: [{ id: "app:jellyfin" }] } });
    expect(fail).toMatchObject({ key: "app:immich", message: "Immich didn't answer in time.", timedOut: true });
    expect(group.t).toBeLessThan(fail.t);
    // The budget, not the provider's own 1 s, decides when it ends.
    expect(events.at(-1)!.t).toBeLessThan(500);
    expect(events.at(-1)!.type).toBe("done");
  });

  it("explains an app's own failure to admins and keeps it plain for members", async () => {
    const broken: ProviderDef = { key: "app:x", name: "Jellyfin", tier: "app", run: () => Promise.reject(new AppError("upstream_auth", "Jellyfin answered 401: the API key is wrong.", 502)) };
    const a = (await collect(admin, "dune", [broken])).find((e) => e.type === "fail");
    const m = (await collect(member, "dune", [broken])).find((e) => e.type === "fail");
    expect(a).toMatchObject({ message: "Jellyfin answered 401: the API key is wrong.", timedOut: false });
    expect(m).toMatchObject({ message: "Jellyfin couldn't search just now." });
  });

  it("runs only the providers for the chosen scope", async () => {
    const files: ProviderDef = { key: "files", name: "Files", scope: "files", run: () => [{ id: "f", label: "jelly.mkv" }] };
    const keys = (await collect(admin, "jelly", [fast, files], { scope: "files" })).flatMap((e) => (e.type === "group" ? [e.group.key] : []));
    expect(keys).toEqual(["files"]);
  });

  it("stops emitting once the person types something else", async () => {
    const ctrl = new AbortController();
    const slow: ProviderDef = { key: "slow", name: "Slow", run: async (_u, _q, ctx) => (await sleep(80, ctx.signal), [{ id: "x", label: "x" }]) };
    const p = collect(admin, "xx", [slow], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    const events = await p;
    expect(events.map((e) => e.type)).toEqual(["start"]);
  });

  it("replays a cached answer and asks a failed app again", async () => {
    let calls = 0;
    let appCalls = 0;
    const counted: ProviderDef = { ...fast, run: (...a) => (calls++, fast.run(...a)) };
    const flaky: ProviderDef = { key: "app:j", name: "Jellyfin", tier: "app", run: () => (appCalls++ === 0 ? Promise.reject(new Error("boom")) : [{ id: "dune", label: "Dune" }]) };
    await collect(admin, "dune", [counted, flaky], { noCache: false });
    const second = await collect(admin, "dune", [counted, flaky], { noCache: false });
    expect(calls).toBe(1);
    expect(appCalls).toBe(2);
    expect(second.filter((e) => e.type === "group").map((e) => e.type === "group" && e.group.key)).toEqual(["fast", "app:j"]);
    // Another person never gets this person's cached answer.
    await collect(member, "dune", [counted, flaky], { noCache: false });
    expect(calls).toBe(2);
  });

  it("lets a cached answer expire 20 s after the provider answered, however often the query is repeated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let calls = 0;
    const counted: ProviderDef = { ...fast, run: (...a) => (calls++, fast.run(...a)) };
    const at = (s: number) => vi.setSystemTime(new Date(2026, 9, 7, 12, 0, s));
    at(0);
    await collect(admin, "dune", [counted], { noCache: false });
    at(15);
    await collect(admin, "dune", [counted], { noCache: false }); // replayed
    at(25);
    await collect(admin, "dune", [counted], { noCache: false }); // 25 s after it answered: asked again
    expect(calls).toBe(2);
  });

  it("never answers from the cache after what the person may see has changed", async () => {
    let calls = 0;
    const counted: ProviderDef = { ...fast, run: (...a) => (calls++, fast.run(...a)) };
    await collect(member, "dune", [counted], { noCache: false, grants: "member:with-share" });
    await collect(member, "dune", [counted], { noCache: false, grants: "member:share-revoked" });
    expect(calls).toBe(2);
  });

  it("drops links that could leave Gluon unexpectedly and keeps server-only fields off the wire", async () => {
    const sly: ProviderDef = {
      key: "sly",
      name: "Sly",
      run: () => [
        { id: "a", label: "Protocol-relative", href: "//evil.example" },
        { id: "b", label: "Script", href: "javascript:alert(1)", external: true },
        { id: "c", label: "Fine", href: "/apps/x", keywords: "secret words", action: { url: "https://evil.example/api", pending: "", failed: "" } },
      ],
    };
    const g = (await collect(admin, "zz", [sly])).find((e) => e.type === "group");
    const byId = Object.fromEntries((g?.type === "group" ? g.group.items : []).map((it) => [it.id, it]));
    expect(byId.a!.href).toBeUndefined();
    expect(byId.b!.href).toBeUndefined();
    expect(byId.c).toEqual({ id: "c", label: "Fine", href: "/apps/x", score: expect.any(Number) });
  });

  it("keeps older (user, q) => group providers working, once each across hot reloads", async () => {
    const legacy = async () => ({ name: "Public addresses", items: [{ id: "route:1", label: "media.example", href: "/network" }] });
    registerSearch(legacy);
    registerSearch(legacy);
    const groups = (await collect(admin, "media", [])).flatMap((e) => (e.type === "group" ? [e.group] : []));
    expect(groups).toMatchObject([{ name: "Public addresses", priority: 22, items: [{ id: "route:1", href: "/network" }] }]);
  });
});
