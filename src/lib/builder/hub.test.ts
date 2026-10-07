import { describe, expect, it } from "vitest";
import { hubQuery, mapHubSearch, mapHubTags, pageTags, retryAt, sortTags } from "./hub";

// Trimmed from real answers of hub.docker.com/v2/search/repositories (2026-10).
const SEARCH = {
  count: 990,
  next: "https://hub.docker.com/v2/search/repositories/?page=2&page_size=3&query=jellyfin",
  results: [
    { repo_name: "jellyfin/jellyfin", short_description: "The Free Software Media Browser ", star_count: 1595, pull_count: 429178441, repo_owner: "", is_automated: false, is_official: false },
    { repo_name: "linuxserver/jellyfin", short_description: "", star_count: 814, pull_count: 152849693, repo_owner: "", is_automated: false, is_official: false },
    { repo_name: "library/nginx", short_description: "Official build of Nginx.", star_count: 21405, pull_count: 13437965584, is_official: true },
    { repo_name: "nginx", short_description: "Official build of Nginx.", star_count: 21405, pull_count: 13437965584, is_official: true },
    { repo_name: "", short_description: "broken row" },
  ],
};

describe("Docker Hub search", () => {
  it("maps repositories, trims descriptions and folds library/ into the official name", () => {
    expect(mapHubSearch(SEARCH)).toEqual([
      { ref: "jellyfin/jellyfin", description: "The Free Software Media Browser", stars: 1595, pulls: 429178441, official: false },
      { ref: "linuxserver/jellyfin", description: "", stars: 814, pulls: 152849693, official: false },
      { ref: "nginx", description: "Official build of Nginx.", stars: 21405, pulls: 13437965584, official: true },
    ]);
  });

  it("survives answers that aren't what it expects", () => {
    expect(mapHubSearch(null)).toEqual([]);
    expect(mapHubSearch({ results: "nope" })).toEqual([]);
    expect(mapHubSearch({ results: [{ repo_name: 42 }] })).toEqual([]);
  });

  it.each([
    ["jelly", "jelly"],
    [" Linuxserver/Sonarr ", "linuxserver/sonarr"],
    ["j", null],
    ["nginx:1.27", null],
    ["ghcr.io/owner/app", null],
    ["two words", null],
  ])("sends %j as %j", (input, out) => {
    expect(hubQuery(input)).toBe(out);
  });
});

describe("tags", () => {
  // Shape of hub.docker.com/v2/namespaces/linuxserver/repositories/jellyfin/tags.
  const PAGE = {
    count: 232,
    next: "https://hub.docker.com/v2/namespaces/linuxserver/repositories/jellyfin/tags?page=3",
    results: [
      { name: "arm64v8-10.11.11", tag_last_pushed: "2026-09-01T16:52:58.871274Z", images: [{ architecture: "arm64", os: "linux", size: 288176846 }] },
      { name: "10.11.11", tag_last_pushed: "2026-09-01T16:53:10Z", full_size: 1, images: [{ architecture: "arm64", os: "linux", size: 288176846 }, { architecture: "amd64", os: "linux", size: 340676611 }] },
      { name: "latest", last_updated: "2026-09-02T00:00:00Z", images: [] },
      { name: "sha256-abc.sig", images: [] },
    ],
  };

  it("drops per-architecture and signature tags and picks this server's size", () => {
    const r = mapHubTags(PAGE, "amd64");
    expect(r.next).toBe(true);
    expect(r.tags).toEqual([
      { name: "10.11.11", updated: Date.parse("2026-09-01T16:53:10Z"), size: 340676611 },
      { name: "latest", updated: Date.parse("2026-09-02T00:00:00Z"), size: null },
    ]);
  });

  it("sorts registry tags latest first, then versions newest first, then other words", () => {
    expect(sortTags(["1.9.0", "develop", "1.10.2", "latest", "1.10.10", "v2.0.0-rc1", "amd64-1.0", "stable"])).toEqual(["latest", "stable", "v2.0.0-rc1", "1.10.10", "1.10.2", "1.9.0", "develop"]);
  });

  it("pages and filters beyond the first 20", () => {
    const all = Array.from({ length: 45 }, (_, i) => `1.${45 - i}.0`);
    expect(pageTags(all, "", 3, 20)).toEqual({ tags: all.slice(40), next: false });
    expect(pageTags(all, "1.4", 1, 20).tags).toEqual(["1.45.0", "1.44.0", "1.43.0", "1.42.0", "1.41.0", "1.40.0", "1.4.0"]);
  });
});

describe("rate limits", () => {
  const now = 1_000_000_000_000;
  it("waits as long as Retry-After says, capped at an hour", () => {
    expect(retryAt({ "retry-after": "30" }, now)).toBe(now + 30_000);
    expect(retryAt({ "retry-after": "99999" }, now)).toBe(now + 3600_000);
  });
  it("falls back to Docker Hub's reset time, then to a minute", () => {
    expect(retryAt({ "x-ratelimit-reset": String(now / 1000 + 120) }, now)).toBe(now + 120_000);
    expect(retryAt({}, now)).toBe(now + 60_000);
  });
});
