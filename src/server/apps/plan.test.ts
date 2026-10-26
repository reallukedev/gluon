import { describe, expect, it } from "vitest";
import { finalizePlan, headroom, type FinalizeInput } from "./plan";
import type { Rewritten } from "./rewrite";
import { pickRoot } from "./root";

const GB = 1e9;

function input(over: Partial<FinalizeInput> = {}, rw: Partial<Rewritten> = {}): FinalizeInput {
  return {
    appId: "immich",
    name: "Immich",
    source: "umbrel",
    newId: "immich-gluon",
    folder: "/srv/gluon-apps/immich-gluon",
    rewritten: {
      compose: "services: {}\n",
      envText: null,
      copies: [
        { from: "/srv/umbrel/app-data/immich/data/upload", to: "/srv/gluon-apps/immich-gluon/data/upload", kind: "folder", services: ["server"] },
        { from: "/srv/umbrel/app-data/immich/data/postgres", to: "/srv/gluon-apps/immich-gluon/data/postgres", kind: "folder", services: ["postgres"] },
        { from: "/srv/umbrel/app-data/immich/data/model-cache", to: "/srv/gluon-apps/immich-gluon/data/model-cache", kind: "folder", services: ["machine-learning"] },
      ],
      stays: [],
      sharedVolumes: [],
      ports: [{ host: 2283, container: 2283, proto: "tcp", service: "server" }],
      warnings: [],
      blockers: [],
      ...rw,
    },
    measured: new Map([
      ["/srv/umbrel/app-data/immich/data/upload", { size: 40 * GB, missing: false, file: false }],
      ["/srv/umbrel/app-data/immich/data/postgres", { size: 2 * GB, missing: false, file: false }],
      ["/srv/umbrel/app-data/immich/data/model-cache", { size: 0, missing: true, file: false }],
    ]),
    free: 126 * GB,
    portsInUse: new Map(),
    stops: { name: "Immich", containers: ["immich_server_1"], via: "umbrel" },
    ...over,
  };
}

describe("finalizePlan", () => {
  it("counts what exists and lets the move run when the disk has room", () => {
    const p = finalizePlan(input());
    expect(p.space).toEqual({ needed: 42 * GB, free: 126 * GB, enough: true, unmeasured: [] });
    expect(p.blockers).toEqual([]);
    expect(p.copies.find((c) => c.from.endsWith("model-cache"))).toMatchObject({ missing: true });
  });

  it("refuses when the copy plus headroom doesn't fit, and when free space is unknown", () => {
    // 42 GB fits in 42.5 GB on paper, but not with 5% to spare.
    const tight = finalizePlan(input({ free: 42.5 * GB }));
    expect(tight.space.enough).toBe(false);
    expect(tight.blockers).toHaveLength(1);
    expect(tight.blockers[0]).toMatch(/Free some space first/);
    expect(42 * GB + headroom(42 * GB)).toBeGreaterThan(42.5 * GB);
    expect(finalizePlan(input({ free: null })).blockers[0]).toMatch(/couldn't check how much space/);
  });

  it("still needs 512 MB to spare for a tiny app", () => {
    const tiny = input({ free: 600e6, measured: new Map([["/srv/umbrel/app-data/immich/data/upload", { size: 200e6, missing: false, file: false }]]) });
    expect(finalizePlan(tiny).space.enough).toBe(false);
  });

  it("names what holds a port the copy needs, and flags folders it couldn't measure", () => {
    const measured = input().measured;
    measured.set("/srv/umbrel/app-data/immich/data/postgres", { size: null, missing: false, file: false });
    const p = finalizePlan(input({ measured, portsInUse: new Map([["2283/tcp", "photoprism"]]) }));
    expect(p.blockers).toEqual(["Port 2283 is already used by photoprism. Stop it, or change the port, before moving."]);
    expect(p.space.unmeasured).toEqual(["/srv/umbrel/app-data/immich/data/postgres"]);
    expect(p.warnings[0]).toMatch(/couldn't measure/);
  });

  it("refuses when an internet address reaches a port that loses Umbrel's login", () => {
    const publicPorts = new Map([[5275, "umbrel.example.test/admin"]]);
    const p = finalizePlan(input({ publicPorts }, { loginLostPort: 5275 }));
    expect(p.blockers).toEqual([expect.stringMatching(/^umbrel\.example\.test\/admin sends people from the internet to port 5275/)]);
    // Reachable only at home: the warning from the rewrite is enough.
    expect(finalizePlan(input({ publicPorts: new Map([[2283, "photos.example.test"]]) }, { loginLostPort: 5275 })).blockers).toEqual([]);
  });

  it("keeps its id while sizes change, and changes it when what the move does changes", () => {
    const a = finalizePlan(input());
    const b = finalizePlan(input({ free: 10 * GB }));
    const c = finalizePlan(input({}, { compose: "services: { x: {} }\n" }));
    const d = finalizePlan(input({}, { envText: "APP_SEED='new'\n" }));
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(d.id).not.toBe(a.id);
  });
});

describe("pickRoot", () => {
  const base = { env: undefined, populated: [], umbrelDataDir: null, hasDataAppData: true };
  it("puts apps next to Umbrel's data, unless Gluon already keeps apps somewhere", () => {
    expect(pickRoot({ ...base, umbrelDataDir: "/srv/umbrel" })).toBe("/srv/gluon-apps");
    expect(pickRoot({ ...base, umbrelDataDir: "/home/umbrel/umbrel" })).toBe("/home/umbrel/gluon-apps");
    expect(pickRoot({ ...base, umbrelDataDir: "/srv/umbrel", populated: ["/DATA/AppData/gluon-apps"] })).toBe("/DATA/AppData/gluon-apps");
  });
  it("prefers GLUON_APPS_DIR, and ignores one that isn't a clean absolute path", () => {
    expect(pickRoot({ ...base, env: "/tank/apps/", populated: ["/opt/gluon/apps"] })).toBe("/tank/apps");
    expect(pickRoot({ ...base, env: "/tank/../etc" })).toBe("/DATA/AppData/gluon-apps");
    expect(pickRoot({ ...base, env: "relative/apps", hasDataAppData: false })).toBe("/opt/gluon/apps");
  });
  it("doesn't put apps at the top of the disk when Umbrel lives at the root", () => {
    expect(pickRoot({ ...base, umbrelDataDir: "/umbrel", hasDataAppData: false })).toBe("/opt/gluon/apps");
  });
});
