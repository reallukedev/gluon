import { beforeEach, describe, expect, it, vi } from "vitest";

// Docker Hub is never asked during tests: safeFetch answers from this queue.
const calls: string[] = [];
let answers: { status: number; body?: unknown; headers?: Record<string, string> }[] = [];
vi.mock("../integrations/net", () => ({
  NetError: class NetError extends Error {},
  safeFetch: vi.fn(async (url: string) => {
    calls.push(url);
    const a = answers.shift() ?? { status: 500 };
    return { status: a.status, headers: a.headers ?? {}, url, body: Buffer.from(JSON.stringify(a.body ?? {})), ms: 1 };
  }),
}));
vi.mock("../docker/client", () => ({ docker: () => ({}) }));

const { searchHub, tagPage } = await import("./images");
type G = typeof globalThis & { __gluonHub?: { search: Map<string, unknown>; tags: Map<string, unknown>; lists: Map<string, unknown>; blockedUntil: number } };

beforeEach(() => {
  calls.length = 0;
  answers = [];
  const h = (globalThis as G).__gluonHub!;
  h.search.clear();
  h.tags.clear();
  h.lists.clear();
  h.blockedUntil = 0;
});

describe("Docker Hub search", () => {
  it("asks once per query and answers repeats from the cache", async () => {
    answers = [{ status: 200, body: { results: [{ repo_name: "jellyfin/jellyfin", pull_count: 5 }] } }];
    const first = await searchHub("Jelly");
    const again = await searchHub("jelly ");
    expect(first.results.map((r) => r.ref)).toEqual(["jellyfin/jellyfin"]);
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("query=jelly");
  });

  it("stops asking after a 429 until Docker Hub's reset time, and says what to do", async () => {
    answers = [{ status: 429, headers: { "retry-after": "120" } }];
    const limited = await searchHub("sonarr");
    expect(limited.error).toMatch(/limiting requests .* for 2 minutes\. Type the full image name instead/);
    const next = await searchHub("radarr");
    expect(next.error).toContain("limiting requests");
    expect(calls).toHaveLength(1);
  });

  it("doesn't search for exact references", async () => {
    expect((await searchHub("nginx:1.27")).results).toEqual([]);
    expect((await searchHub("ghcr.io/owner/app")).results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("tag pages", () => {
  it("passes the filter and page to Docker Hub", async () => {
    answers = [{ status: 200, body: { next: "https://hub.docker.com/next", results: [{ name: "10.11.11", images: [] }] } }];
    const p = await tagPage("linuxserver/jellyfin:latest", "10.11", 2);
    expect(p).toMatchObject({ page: 2, next: true, error: null, tags: [{ name: "10.11.11" }] });
    const u = new URL(calls[0]!);
    expect(u.pathname).toBe("/v2/namespaces/linuxserver/repositories/jellyfin/tags");
    expect(u.searchParams.get("name")).toBe("10.11");
    expect(u.searchParams.get("page")).toBe("2");
  });

  it("pages other registries' lists itself, fetching the list once", async () => {
    // ghcr.io: /v2/ asks for a token, the token, then the full tag list.
    answers = [
      { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } },
      { status: 200, body: { token: "t" } },
      { status: 200, body: { tags: Array.from({ length: 70 }, (_, i) => `1.${i}.0`) } },
    ];
    const one = await tagPage("ghcr.io/owner/app", "", 1);
    const two = await tagPage("ghcr.io/owner/app", "", 2);
    expect(one.tags[0]!.name).toBe("1.69.0");
    expect(one.next).toBe(true);
    expect(two.tags[0]!.name).toBe("1.39.0");
    expect(calls.filter((c) => c.includes("/tags/list"))).toHaveLength(1);
  });

  it("explains a private or missing image instead of showing nothing", async () => {
    answers = [{ status: 404 }];
    expect((await tagPage("someone/nothing", "", 1)).error).toBe("Docker Hub has no image called someone/nothing.");
  });
});
