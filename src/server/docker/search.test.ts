import { describe, expect, it, vi } from "vitest";
import { prepare } from "@/lib/search-match";
import type { User } from "../auth/users";
import type { AppSummary } from "./apps";
import type { ProviderGroup } from "../search";

/** The Apps search provider: who sees which apps, and which actions it offers. */

const app = (id: string, name: string, extra: Partial<AppSummary> = {}): AppSummary =>
  ({
    id,
    name,
    kind: "stack",
    source: "casaos",
    summary: "Running",
    icon: null,
    hidden: false,
    copyOf: null,
    description: null,
    category: null,
    urls: { home: `http://192.168.1.230/${id}`, away: null },
    containers: [{ id: `${id}-c`, name: `${id}-server`, service: "server", image: `${id}/${id}:latest`, state: "running", health: null }],
    ...extra,
  }) as unknown as AppSummary;

const apps = [app("jellyfin", "Jellyfin"), app("immich", "Immich", { containers: [{ id: "pg", name: "immich_postgres", service: "db", image: "postgres", state: "running", health: null }] as AppSummary["containers"] })];

vi.mock("./apps", () => ({ listApps: async () => apps, appsForMember: async () => apps.filter((a) => a.id === "jellyfin") }));

const { registeredProviders } = await import("../search");
await import("./index");
const provider = registeredProviders().find((p) => p.key === "apps")!;
const run = async (role: "admin" | "member", q: string) =>
  (await provider.run({ id: role, username: role, role } as User, q, { signal: new AbortController().signal, query: prepare(q), zone: "home", scope: "all" })) as ProviderGroup[];

describe("Apps search", () => {
  it("members see only their apps, opening the app itself, with no actions or containers", async () => {
    expect((await run("member", "immich")).flatMap((g) => g.items)).toEqual([]);
    const groups = await run("member", "jelly");
    expect(groups.map((g) => g.name)).toEqual(["Apps"]);
    expect(groups[0]!.items[0]).toMatchObject({ label: "Jellyfin", href: "http://192.168.1.230/jellyfin", external: true });
  });

  it("admins get the asked-for action first, and actions that interrupt people ask first", async () => {
    const actions = (await run("admin", "restart jelly")).find((g) => g.name === "Actions")!.items;
    const top = [...actions].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;
    expect(top.label).toBe("Restart Jellyfin");
    expect(top.action).toMatchObject({ url: "/api/apps/jellyfin/action", body: { action: "restart" }, confirm: { confirmLabel: "Restart" } });
    expect(actions.find((a) => a.label === "Stop Jellyfin")!.action!.confirm).toMatchObject({ danger: true });
  });

  it("finds a container by its own name inside an app called something else", async () => {
    const groups = await run("admin", "postgres");
    expect(groups.find((g) => g.name === "Containers")!.items[0]).toMatchObject({ label: "immich_postgres", href: "/apps/immich?tab=logs&container=immich_postgres" });
  });
});
