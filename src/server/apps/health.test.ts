import { describe, expect, it } from "vitest";
import { assess, oneShotServices, type ContainerState } from "./health";

const ctr = (name: string, over: Partial<ContainerState> = {}): ContainerState => ({ name, service: name, status: "running", exitCode: 0, health: null, restartCount: 0, ...over });

describe("is the new copy up?", () => {
  it("fails a container that exited cleanly unless the file says it's a one-off job", () => {
    const compose = `services:
  migrate:
    image: app
    command: migrate
  web:
    image: app
    depends_on:
      migrate:
        condition: service_completed_successfully
  seed:
    image: app
    labels:
      - gluon.one-shot=true
  worker:
    image: app
`;
    const oneShot = oneShotServices(compose);
    expect([...oneShot].sort()).toEqual(["migrate", "seed"]);
    const firsts = new Map<string, number>();
    const r = assess([ctr("migrate", { status: "exited" }), ctr("seed", { status: "exited" }), ctr("web"), ctr("worker", { status: "exited" })], firsts, oneShot);
    expect(r.bad).toEqual([{ name: "worker", why: "stopped right after starting" }]);
    // Without the declarations, a clean exit is just as much a failure.
    expect(assess([ctr("migrate", { status: "exited" })], new Map(), new Set()).bad).toHaveLength(1);
  });

  it("waits for health checks, and fails one that keeps restarting even if each look catches it running", () => {
    const firsts = new Map<string, number>();
    expect(assess([ctr("db", { health: "starting" }), ctr("web", { status: "created" })], firsts, new Set())).toEqual({ bad: [], waiting: 2 });
    expect(assess([ctr("db", { health: "unhealthy" })], new Map(), new Set()).bad[0]!.why).toBe("fails its health check");
    // Counted from the first look: a container that had restarted before the move doesn't count against it.
    const looks = new Map<string, number>();
    expect(assess([ctr("web", { restartCount: 4 })], looks, new Set()).bad).toEqual([]);
    expect(assess([ctr("web", { restartCount: 5 })], looks, new Set()).bad).toEqual([]);
    expect(assess([ctr("web", { restartCount: 6 })], looks, new Set()).bad).toEqual([{ name: "web", why: "keeps restarting" }]);
    expect(assess([ctr("job", { status: "exited", exitCode: 3 })], new Map(), new Set(["job"])).bad[0]!.why).toBe("stopped with code 3");
  });
});
