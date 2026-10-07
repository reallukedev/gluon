import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepare } from "@/lib/search-match";
import type { SearchEvent } from "@/lib/search-types";
import { buildSections, type StreamState } from "@/components/shell/paletteModel";
import type { AppSummary } from "./docker/apps";
import type { User } from "./auth/users";

/**
 * A query that starts with a verb should make Enter do what was typed: from the providers, through
 * the stream, to the palette's "best match". Ambiguous destructive actions are never the best match.
 */

const app = (id: string, name: string, source: AppSummary["source"], extra: Partial<AppSummary> = {}): AppSummary =>
  ({
    id,
    name,
    kind: "stack",
    source,
    summary: "Running",
    icon: null,
    hidden: false,
    copyOf: null,
    webPort: 8096,
    routes: [],
    urls: { home: `http://192.168.1.230/${id}`, away: null },
    containers: [{ id: `${id}-c`, name: `${id}-server`, service: "server", image: "jellyfin/jellyfin", state: "running", health: null }],
    ...extra,
  }) as unknown as AppSummary;

let apps: AppSummary[] = [];
vi.mock("./docker/apps", () => ({ listApps: async () => apps, appsForMember: async () => apps }));
vi.mock("./diagnostics/caddy-log", () => ({ ensureCaddyFollower: () => undefined }));

const { runSearch, clearSearchCache } = await import("./search");
await import("./docker/index");
await import("./diagnostics/index");

const admin = { id: "a", username: "luke", role: "admin" } as User;

/** What the palette would show for this query, given what the server streamed. */
async function palette(q: string) {
  let stream: StreamState = { term: q, scope: "all", groups: [], pending: [], failed: [], order: [], done: false, error: null };
  const events: SearchEvent[] = [];
  await runSearch(admin, q, { scope: "all", zone: "home", signal: new AbortController().signal, noCache: true, emit: (e) => events.push(e) });
  for (const e of events) if (e.type === "group") stream = { ...stream, groups: [...stream.groups, e.group] };
  stream.done = true;
  return buildSections({ query: prepare(q), scope: "all", statics: [], stream, recent: [], perGroup: 5 });
}
const best = async (q: string) => (await palette(q)).find((s) => s.best)?.items[0]?.label ?? null;

beforeEach(() => {
  clearSearchCache();
  apps = [app("jellyfin", "Jellyfin", "casaos"), app("immich", "Immich", "casaos")];
});

describe("verbs", () => {
  it("makes the asked-for action the best match, still asking before a restart or stop", async () => {
    expect(await best("restart jelly")).toBe("Restart Jellyfin");
    expect(await best("stop jellyfin")).toBe("Stop Jellyfin");
    expect(await best("open jellyfin")).toBe("Open Jellyfin");
    expect(await best("show the logs for jellyfin")).toBe("Show logs for Jellyfin");
    expect(await best("check jellyfin")).toBe("Check why Jellyfin won't open");
    expect(await best("why won't jellyfin open")).toBe("Check why Jellyfin won't open");
    const restart = (await palette("restart jelly")).find((s) => s.best)!.items[0]!;
    expect(restart.action?.confirm).toMatchObject({ confirmLabel: "Restart" });
  });

  it("without a verb, the app itself is the best match", async () => {
    expect(await best("jellyfin")).toBe("Jellyfin");
  });

  it("doesn't pick one of two equally good apps for a restart; lists both, told apart by where they run", async () => {
    apps = [app("jellyfin", "Jellyfin", "umbrel"), app("jellyfin-compose", "Jellyfin", "compose")];
    const sections = await palette("restart jellyfin");
    expect(sections.some((s) => s.best)).toBe(false);
    const restarts = sections.find((s) => s.name === "Actions")!.items.filter((i) => i.label === "Restart Jellyfin");
    expect(restarts.map((i) => i.hint)).toEqual(["Stops it and starts it again · Umbrel", "Stops it and starts it again · Compose"]);
  });
});
