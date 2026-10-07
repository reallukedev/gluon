import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchResult } from "../net";

/**
 * Each kind's `search`, run against recorded-shape answers from the real apps (no network): which
 * requests it makes, how hits are labelled, ordered and linked, and that images go through the proxy.
 */

type Route = (url: URL, init: { method?: string; body?: string }) => unknown;
let routes: Record<string, Route> = {};
const calls: { method: string; url: URL; body?: string; signal?: AbortSignal }[] = [];

vi.mock("../net", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../net")>();
  return {
    ...orig,
    safeFetch: vi.fn(async (raw: string, init: { method?: string; body?: string; signal?: AbortSignal }): Promise<FetchResult> => {
      const url = new URL(raw);
      calls.push({ method: init.method ?? "GET", url, body: init.body, signal: init.signal });
      const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
      if (!route) return { status: 404, headers: {}, url: raw, body: Buffer.from(""), ms: 1 };
      const out = route(url, init);
      return { status: 200, headers: { "content-type": "application/json" }, url: raw, body: Buffer.from(JSON.stringify(out)), ms: 1 };
    }),
  };
});

const { def: jellyfin } = await import("./jellyfin");
const { def: immich } = await import("./immich");
const { def: subsonic } = await import("./subsonic");
const { def: slskd } = await import("./slskd");
const { def: homebridge } = await import("./homebridge");

const opts = { limit: 6, signal: new AbortController().signal };
const ctx = <C>(baseUrl: string, config: C) => ({ id: "int1", name: "App", baseUrl, config, version: 1 });

beforeEach(() => {
  routes = {};
  calls.length = 0;
});

const ID = (n: number) => n.toString(16).padStart(32, "0");

describe("Jellyfin", () => {
  it("asks /Items with the search term and links each hit to its page in Jellyfin", async () => {
    routes["GET /jf/Items"] = () => ({
      Items: [
        { Name: "Dune", Id: ID(1), Type: "Episode", SeriesName: "Frank Herbert's Dune", ParentIndexNumber: 1, IndexNumber: 2, SeriesId: ID(9), SeriesPrimaryImageTag: "ab12", ServerId: "srv" },
        { Name: "Dune: Part Two", Id: ID(2), Type: "Movie", ProductionYear: 2024, ImageTags: { Primary: "cd34" }, ServerId: "srv" },
        { Name: "Dune", Id: ID(3), Type: "Movie", ProductionYear: 2021, ImageTags: { Primary: "ef56" }, ServerId: "srv" },
        { Name: "Dune Soundtrack", Id: ID(4), Type: "Folder" },
        { Name: "Spice", Id: ID(5), Type: "Audio", AlbumArtist: "Hans Zimmer", Album: "Dune OST", AlbumId: ID(6), AlbumPrimaryImageTag: "aa11", ServerId: "srv" },
      ],
    });
    const hits = await jellyfin.search!(ctx("http://127.0.0.1:8096/jf", { apiKey: "k".repeat(32), userId: ID(7), allowSelfSigned: false }), "dune", opts);
    const q = calls[0]!.url.searchParams;
    expect(q.get("searchTerm")).toBe("dune");
    expect(q.get("userId")).toBe(ID(7));
    expect(calls[0]!.url.pathname).toBe("/jf/Items");
    // The search's own signal reaches the request, so a cancelled search stops the HTTP call.
    expect(calls[0]!.signal).toBe(opts.signal);

    // Exact name first, films before the same-named episode; folders aren't results.
    expect(hits.map((h) => [h.label, h.type, h.hint])).toEqual([
      ["Dune", "film", "Film · 2021"],
      ["Dune", "episode", "Episode · Frank Herbert's Dune S1 E2"],
      ["Dune: Part Two", "film", "Film · 2024"],
      ["Spice", "song", "Song · Hans Zimmer, Dune OST"],
    ]);
    expect(hits[0]!.url).toBe(`http://127.0.0.1:8096/jf/web/#/details?id=${ID(3)}&serverId=srv`);
    // Posters come through Gluon's image proxy (the episode uses its series' poster).
    expect((hits[1] as { image?: string }).image).toMatch(new RegExp(`^/api/integrations/int1/image\\?item=${ID(9)}&`));
  });
});

describe("Immich", () => {
  const c = ctx("http://immich.lan:2283", { apiKey: "x".repeat(24), allowSelfSigned: false });
  const asset = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "IMAGE", originalFileName: `${id.slice(0, 4)}.jpg`, localDateTime: "2021-08-12T19:04:00.000Z", exifInfo: { city: "Lisbon", country: "Portugal" }, ...extra });
  const U = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

  it("finds photos by what's in them, plus people, places and albums by name", async () => {
    routes["GET /api/search/person"] = () => [{ id: "p1", name: "Sunny", isHidden: false }];
    routes["GET /api/search/places"] = () => [{ name: "Sunset Beach", admin1name: "Hawaii", countryName: "United States" }];
    routes["GET /api/albums"] = () => [
      { id: "al1", albumName: "Sunset walks", assetCount: 12, albumThumbnailAssetId: U(9) },
      { id: "al2", albumName: "Kitchen", assetCount: 3 },
    ];
    routes["POST /api/search/smart"] = () => ({ assets: { items: [asset(U(1)), asset(U(2), { isTrashed: true }), asset(U(3), { visibility: "locked" }), asset(U(4), { type: "VIDEO" })], nextPage: null } });
    const hits = await immich.search!(c, "sunset", opts);
    expect(JSON.parse(calls.find((x) => x.method === "POST")!.body!)).toMatchObject({ query: "sunset" });
    expect(hits.map((h) => [h.type, h.label, h.hint])).toEqual([
      ["album", "Sunset walks", "Album · 12 items"],
      ["place", "Sunset Beach", "Place · Hawaii, United States"],
      ["photo", "0000.jpg", "Photo · Lisbon, Portugal · 2021"],
      ["video", "0000.jpg", "Video · Lisbon, Portugal · 2021"],
      ["person", "Sunny", "Person"],
    ]);
    expect(hits.find((h) => h.type === "photo")!.url).toBe(`http://immich.lan:2283/photos/${U(1)}`);
    expect((hits.find((h) => h.type === "photo") as { image?: string }).image).toBe(`/api/integrations/int1/image?asset=${U(1)}&size=thumbnail`);
  });

  it("still finds people when smart search is off, and says why only when everything fails", async () => {
    routes["GET /api/search/person"] = () => [{ id: "p1", name: "Sam" }];
    routes["GET /api/search/places"] = () => [];
    routes["GET /api/albums"] = () => [];
    // No smart search route: that part answers 404 and fails on its own.
    expect((await immich.search!(c, "sam", opts)).map((h) => h.label)).toEqual(["Sam"]);
    routes = {};
    await expect(immich.search!(c, "sam", opts)).rejects.toThrow(/Immich answered 404/);
  });
});

describe("Music server (Subsonic)", () => {
  it("maps search3 into artists, albums and songs, linking into Navidrome", async () => {
    routes["GET /rest/search3.view"] = () => ({
      "subsonic-response": {
        status: "ok",
        type: "navidrome",
        searchResult3: {
          artist: [{ id: "ar1", name: "Radiohead", albumCount: 9, coverArt: "ar-ar1" }],
          album: [{ id: "al1", name: "OK Computer", artist: "Radiohead", year: 1997, coverArt: "al-al1" }],
          song: [{ id: "s1", title: "Airbag", artist: "Radiohead", album: "OK Computer", albumId: "al1", coverArt: "al-al1" }],
        },
      },
    });
    const hits = await subsonic.search!(ctx("http://music.lan:4533", { auth: "apiKey", username: "", password: "", token: "", salt: "", apiKey: "key", allowSelfSigned: false }), "radiohead", opts);
    expect(calls[0]!.url.searchParams.get("query")).toBe("radiohead");
    expect(hits.map((h) => [h.type, h.label, h.hint, h.url])).toEqual([
      ["artist", "Radiohead", "Artist · 9 albums", "http://music.lan:4533/app/#/artist/ar1/show"],
      ["album", "OK Computer", "Album · Radiohead · 1997", "http://music.lan:4533/app/#/album/al1/show"],
      ["song", "Airbag", "Song · Radiohead, OK Computer", "http://music.lan:4533/app/#/album/al1/show"],
    ]);
  });
});

describe("slskd", () => {
  it("searches only what slskd already has: downloads and earlier searches", async () => {
    routes["POST /api/v0/session"] = () => ({ token: "jwt", expires: Math.floor(Date.now() / 1000) + 3600 });
    routes["GET /api/v0/transfers/downloads"] = () => [
      { username: "peer1", directories: [{ directory: "Music\\Boards of Canada\\Geogaddi", files: [{ id: "f1", username: "peer1", filename: "Music\\Boards of Canada\\Geogaddi\\01 Ready Lets Go.flac", state: "Completed, Succeeded", size: 10, bytesTransferred: 10 }] }] },
    ];
    routes["GET /api/v0/searches"] = () => [{ id: "s-1", searchText: "boards of canada geogaddi", fileCount: 240, state: "Completed" }];
    const hits = await slskd.search!(ctx("http://127.0.0.1:5030", { username: "slskd", password: "slskd", allowSelfSigned: false }), "geogaddi", opts);
    expect(calls.some((x) => x.method === "POST" && x.url.pathname.startsWith("/api/v0/searches"))).toBe(false);
    expect(hits.map((h) => [h.type, h.label, h.hint])).toEqual([
      ["search", "boards of canada geogaddi", "Earlier search · 240 files found"],
      ["download", "01 Ready Lets Go.flac", "Downloaded · Geogaddi · from peer1"],
    ]);
  });
});

describe("Homebridge", () => {
  it("finds accessories by name, room or kind, with their state", async () => {
    routes["GET /api/auth/settings"] = () => ({ formAuth: true, env: { homebridgeInstanceName: "Home" } });
    routes["POST /api/auth/login"] = () => ({ access_token: "jwt", expires_in: 3600 });
    routes["GET /api/accessories"] = () => [
      { uniqueId: "a1", humanType: "Lightbulb", serviceName: "Ceiling", values: { On: 1, Brightness: 60 }, instance: { username: "x" }, aid: 2 },
      { uniqueId: "a2", humanType: "TemperatureSensor", serviceName: "Bedroom temp", values: { CurrentTemperature: 20.44 }, instance: { username: "x" }, aid: 3 },
      { uniqueId: "a3", humanType: "Switch", serviceName: "Kettle", values: { On: 0 }, instance: { username: "x" }, aid: 4 },
    ];
    routes["GET /api/accessories/layout"] = () => [{ name: "Kitchen", services: [{ uniqueId: "a1" }, { uniqueId: "a3" }] }, { name: "Bedroom", services: [{ uniqueId: "a2" }] }];
    const c = ctx("http://127.0.0.1:8581", { username: "gluon", password: "pw", allowSelfSigned: false });
    expect((await homebridge.search!(c, "kitchen", opts)).map((h) => [h.label, h.hint])).toEqual([
      ["Ceiling", "Light · Kitchen · on, 60%"],
      ["Kettle", "Switch · Kitchen · off"],
    ]);
    expect((await homebridge.search!(c, "bedroom temp", opts)).map((h) => h.hint)).toEqual(["Temperature sensor · Bedroom · 20.4 °C"]);
  });
});
