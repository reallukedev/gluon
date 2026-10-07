import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepare } from "@/lib/search-match";
import type { User } from "./auth/users";
import type { SearchCtx } from "./search";
import type { Places } from "@/lib/files-types";

/** Who sees what in universal search, and how results from connected apps and files are shaped. */

const admin = { id: "a", username: "luke", role: "admin" } as User;
const member = { id: "m", username: "sam", role: "member" } as User;

interface Rec {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  appId: string | null;
  shared: boolean;
  config: Record<string, unknown> | null;
}
const state = {
  recs: [] as Rec[],
  memberApps: [] as string[],
  apps: [] as { id: string; urls: { home: string | null; away: string | null } }[],
  places: { places: [], pins: [], recent: [], admin: true } as Places,
  fileGrants: [] as { id: string; path: string; access: string }[],
  usableCalls: 0,
  asked: [] as { root: string | null; word: string; signal?: AbortSignal }[],
  names: [] as string[],
  search: vi.fn(async (_ctx: unknown, _q: string) => [] as unknown[]),
};

vi.mock("./integrations/registry", () => {
  const searchable = { search: (...a: [unknown, string]) => state.search(...a) };
  return { KINDS: { jellyfin: searchable, immich: searchable, "generic-json": {} } };
});
vi.mock("./db", () => ({ all: (sql: string) => (sql.includes("file_grants") ? state.fileGrants : []) }));
vi.mock("./integrations/store", () => ({
  usableRecords: (u: Pick<User, "role">) => (state.usableCalls++, state.recs.filter((r) => r.config && (u.role === "admin" || r.shared))),
  contextFor: (r: Rec) => ({ id: r.id, name: r.name, baseUrl: r.baseUrl, config: r.config, version: 1 }),
}));
vi.mock("./docker/apps", () => ({
  appsForMember: async () => state.apps.filter((a) => state.memberApps.includes(a.id)),
  listApps: async () => state.apps,
  lanHost: async () => "192.168.1.230",
}));
vi.mock("./findings", () => ({ listOpen: () => [{ id: "f1", kind: "disk", severity: "attention", subject: "/var", title: "/var is 92% full", cause: "Logs are growing.", remedy: { action: "logs.vacuum", label: "Free 2 GB" } }] }));
vi.mock("./audit", () => ({ listActivity: () => [{ id: 1, at: 1, kind: "user", username: "luke", action: "app.restart", target: "jellyfin", summary: "Restarted Jellyfin" }] }));
vi.mock("./files/places", () => ({ places: async () => state.places }));
vi.mock("./files/search", () => ({
  searchNames: async (_u: unknown, root: string | null, word: string, o: { signal?: AbortSignal }) => {
    state.asked.push({ root, word, signal: o.signal });
    // A trailing slash marks a folder.
    return state.names.map((raw) => {
      const dir = raw.endsWith("/");
      const path = dir ? raw.slice(0, -1) : raw;
      return { path, name: path.split("/").pop(), type: dir ? "dir" : "file", size: 1, mtime: 1, kind: dir ? "folder" : path.endsWith(".jpg") ? "image" : "video" };
    });
  },
}));

const { searchSetup, scopesFor, grantsKey } = await import("./search-sources");
const providers = async (u: User, scope = "all") => (await searchSetup(u, scope))!.extra;

const ctx = (q: string, zone: "home" | "away" = "home"): SearchCtx => ({ signal: new AbortController().signal, query: prepare(q), zone, scope: "all" });
const rec = (id: string, extra: Partial<Rec> = {}): Rec => ({ id, kind: "jellyfin", name: `Jellyfin ${id}`, baseUrl: "http://127.0.0.1:8096", appId: null, shared: false, config: {}, ...extra });

beforeEach(() => {
  state.recs = [];
  state.memberApps = [];
  state.apps = [];
  state.places = { places: [], pins: [], recent: [], admin: true };
  state.asked = [];
  state.fileGrants = [];
  state.usableCalls = 0;
  state.names = [];
  state.search.mockReset();
  state.search.mockResolvedValue([]);
});

const appKeys = async (u: User) => (await providers(u, "all")).filter((p) => p.tier === "app").map((p) => p.key);

describe("connected apps in search", () => {
  it("members only search inside shared connections whose app they may open; admins search all", async () => {
    state.apps = [{ id: "jf", urls: { home: null, away: null } }, { id: "jf2", urls: { home: null, away: null } }];
    state.memberApps = ["jf"];
    state.recs = [
      rec("private"),
      rec("shared-mine", { shared: true, appId: "jf" }),
      rec("shared-not-mine", { shared: true, appId: "jf2" }),
      rec("shared-unlinked", { shared: true }),
      rec("broken", { shared: true, config: null }),
      rec("no-search", { kind: "generic-json", shared: true }),
    ];
    expect(await appKeys(member)).toEqual(["app:shared-mine", "app:shared-unlinked"]);
    expect(await appKeys(admin)).toEqual(["app:private", "app:shared-mine", "app:shared-not-mine", "app:shared-unlinked"]);
    expect((await scopesFor(member)).map((s) => s.id)).toEqual(["all", "apps", "app:shared-mine", "app:shared-unlinked"]);
  });

  it("never lets members search inside Immich, even when the connection is shared (the key sees the owner's photos)", async () => {
    state.recs = [rec("photos", { kind: "immich", shared: true }), rec("films", { shared: true })];
    expect(await appKeys(member)).toEqual(["app:films"]);
    expect((await scopesFor(member)).map((s) => s.id)).not.toContain("app:photos");
    expect(await appKeys(admin)).toEqual(["app:photos", "app:films"]);
  });

  it("points links at an address the person can open, and only passes images from the app's own proxy", async () => {
    state.apps = [{ id: "jf", urls: { home: "http://192.168.1.230:8096", away: "https://watch.example.org" } }];
    state.recs = [rec("linked", { appId: "jf" }), rec("loopback")];
    state.search.mockResolvedValue([
      { id: "1", label: "Dune", url: "http://127.0.0.1:8096/web/#/details?id=1", type: "film", image: "/api/integrations/linked/image?item=1" },
      { id: "2", label: "Arrival", url: "javascript:alert(1)", image: "https://tracker.example/pixel.gif" },
    ]);
    const [linked, loopback] = (await providers(admin, "all")).filter((p) => p.tier === "app");
    const away = await linked!.run(admin, "dune", ctx("dune", "away"));
    const atHome = await loopback!.run(admin, "dune", ctx("dune"));
    const awayLoop = await (await providers(admin, "all")).find((p) => p.key === "app:loopback")!.run(admin, "dune", ctx("dune", "away"));
    const items = (r: unknown) => (r as { items: { href?: string; image?: string | null }[] }).items;
    expect(items(away)[0]).toMatchObject({ href: "https://watch.example.org/web/#/details?id=1", image: "/api/integrations/linked/image?item=1", external: true });
    expect(items(away)[1]).toMatchObject({ image: null });
    expect(items(away)[1]!.href).toBeUndefined();
    expect(items(atHome)[0]!.href).toBe("http://192.168.1.230:8096/web/#/details?id=1");
    // Away from home a 127.0.0.1 address can't be opened, so there's no link rather than a broken one.
    expect(items(awayLoop)[0]!.href).toBeUndefined();
    expect(items(atHome)[0]!.image).toBeNull(); // another connection's proxy URL
  });

  it("tells the app who is asking, so per-person kinds (Home Assistant) scope their answer", async () => {
    state.recs = [rec("shared", { shared: true })];
    for (const u of [admin, member]) {
      const [p] = (await providers(u, "all")).filter((x) => x.tier === "app");
      await p!.run(u, "lamp", ctx("lamp"));
    }
    expect(state.search.mock.calls.map(([c]) => (c as { viewer?: unknown }).viewer)).toEqual([
      { id: "a", role: "admin" },
      { id: "m", role: "member" },
    ]);
  });
});

describe("setting up a search", () => {
  it("works out the person's connections once for a scoped search, and refuses scopes that aren't theirs", async () => {
    state.recs = [rec("films", { shared: true }), rec("private")];
    expect((await searchSetup(member, "app:films"))!.extra.map((p) => p.key)).toContain("app:films");
    expect(state.usableCalls).toBe(1);
    expect(await searchSetup(member, "app:private")).toBeNull();
    expect(await searchSetup(member, "files")).toBeNull(); // no shared folders
  });

  it("changes the cache fingerprint when a member loses a shared folder", () => {
    state.fileGrants = [{ id: "g1", path: "/srv/media", access: "read" }];
    const before = grantsKey(member);
    state.fileGrants = [];
    expect(grantsKey(member)).not.toBe(before);
    expect(grantsKey(admin)).toBe("admin");
  });
});

describe("Gluon's own things", () => {
  it("problems, activity and commands are for admins only", async () => {
    const list = await providers(member, "all");
    for (const key of ["findings", "activity", "commands"]) {
      const p = list.find((x) => x.key === key)!;
      expect(await p.run(member, "full", ctx("full"))).toBeNull();
    }
  });

  it("offers a problem's fix as an action that always asks first", async () => {
    const p = (await providers(admin, "all")).find((x) => x.key === "findings")!;
    const res = (await p.run(admin, "var full", ctx("var full"))) as { items: { id: string; action?: { url: string; confirm?: unknown } }[] };
    expect(res.items.map((i) => i.id)).toEqual(["finding:f1", "remedy:f1"]);
    expect(res.items[1]!.action).toMatchObject({ url: "/api/remedies", confirm: { confirmLabel: "Free 2 GB" } });
  });

  it("makes the fix the best match when asked for with \"fix\"", async () => {
    const p = (await providers(admin, "all")).find((x) => x.key === "findings")!;
    const res = (await p.run(admin, "fix var", ctx("fix var"))) as { items: { id: string; score?: number; final?: boolean }[] };
    expect(res.items.find((i) => i.id === "remedy:f1")).toMatchObject({ score: 1, final: true });
  });
});

describe("files by name", () => {
  it("asks the files module for names everywhere the person may look, under a deadline, and ranks them", async () => {
    state.places = {
      admin: true,
      recent: [{ id: "r", label: "films", path: "/srv/media/films", kind: "recent", access: "write" }],
      pins: [],
      places: [{ id: "media", label: "media", path: "/srv/media", kind: "media", access: "write" }],
    };
    state.names = ["/srv/media/films/Dune (2021).mkv", "/srv/media/films/dune-poster.jpg", "/home/luke/notes/dune.txt"];
    const files = (await providers(admin, "files")).find((x) => x.key === "files")!;
    const parent = new AbortController();
    const res = (await files.run(admin, "dune", { ...ctx("dune"), signal: parent.signal })) as { items: { label: string; href?: string; image?: string | null }[] };
    expect(state.asked).toMatchObject([{ root: null, word: "dune" }]);
    // Its own deadline, joined to the search's: cancelling the search stops the walk.
    const signal = state.asked[0]!.signal!;
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
    // The closest name first ("dune.txt" is shortest); the others tie and keep the order they were found in.
    expect(res.items.map((i) => i.label)).toEqual(["dune.txt", "Dune (2021).mkv", "dune-poster.jpg"]);
    expect(res.items.find((i) => i.label === "dune-poster.jpg")!.image).toBe("/api/files/thumb?path=%2Fsrv%2Fmedia%2Ffilms%2Fdune-poster.jpg&size=160");
    expect(res.items.find((i) => i.label === "dune.txt")!.href).toBe("/files?path=%2Fhome%2Fluke%2Fnotes&select=dune.txt");
  });

  it("lists matching pinned, well-known and recent folders first, forgivingly", async () => {
    state.places = {
      admin: true,
      recent: [{ id: "r", label: "Fílms", path: "/srv/media/films", kind: "recent", access: "write" }],
      pins: [{ id: "p", label: "Photos", path: "/srv/photos", kind: "pin", access: "read" }],
      places: [],
    };
    state.names = ["/srv/media/films/"];
    const files = (await providers(admin, "files")).find((x) => x.key === "files")!;
    // Another admin, so the minute-long cache of the first test's folders doesn't answer.
    const other = { ...admin, id: "a2" } as User;
    const res = (await files.run(other, "films", ctx("films"))) as { items: { label: string; href?: string }[] };
    // Found both ways, shown once.
    expect(res.items.map((i) => [i.label, i.href])).toEqual([["Fílms", "/files?path=%2Fsrv%2Fmedia%2Ffilms"]]);
  });
});
