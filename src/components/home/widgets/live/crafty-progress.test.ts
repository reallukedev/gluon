import { describe, expect, test } from "vitest";
import { LAUNCH_LIMIT_MS, pollDelay, settle, START_LIMIT_MS, type Pending } from "./crafty-progress";
import type { CraftyServer } from "@/lib/widgets-types";

const base: CraftyServer = {
  id: "07d7c2b2-8894-4409-a726-8b3b368b63f9",
  name: "Survival",
  game: "Minecraft",
  state: "stopped",
  line: "stopped",
  running: false,
  players: null,
  version: "1.21.11",
  startedAt: null,
  run: null,
  cpu: null,
  memory: null,
  port: 25565,
  stopTimeoutMs: 60_000,
};
const running = (run: string): CraftyServer => ({ ...base, state: "running", line: "running", running: true, run, players: { online: 0, max: 20, names: [] } });
const starting = (run: string): CraftyServer => ({ ...running(run), state: "starting", line: "starting", players: null });
const t0 = 1_000_000;
const p = (action: Pending["action"], run: string | null = null): Pending => ({ action, since: t0, run });

describe("following a command until Crafty reports it got there", () => {
  test("Crafty answers the start command before it has started anything: that isn't done", () => {
    expect(settle(p("start"), base, t0 + 1000).kind).toBe("wait");
    expect(settle(p("start"), starting("a"), t0 + 5000).kind).toBe("wait");
    expect(settle(p("start"), running("a"), t0 + 30_000).kind).toBe("done");
  });

  test("a restart is done only once a new run answers, not while the old one still does", () => {
    expect(settle(p("restart", "old"), running("old"), t0 + 3000).kind).toBe("wait");
    expect(settle(p("restart", "old"), starting("new"), t0 + 9000).kind).toBe("wait");
    expect(settle(p("restart", "old"), running("new"), t0 + 40_000).kind).toBe("done");
  });

  test("a start that never launched the process fails with a reason, instead of spinning", () => {
    expect(settle(p("start"), base, t0 + LAUNCH_LIMIT_MS - 1000).kind).toBe("wait");
    expect(settle(p("start"), base, t0 + LAUNCH_LIMIT_MS + 1000)).toMatchObject({ kind: "failed" });
    // A restart gets the stop timeout on top, to let the old run shut down first.
    expect(settle(p("restart", "old"), base, t0 + LAUNCH_LIMIT_MS + 1000).kind).toBe("wait");
  });

  test("crashing while starting fails; taking too long says so but keeps watching", () => {
    expect(settle(p("start"), { ...base, state: "crashed", line: "unhealthy" }, t0 + 20_000)).toMatchObject({ kind: "failed" });
    expect(settle(p("start"), starting("a"), t0 + START_LIMIT_MS + 1000)).toMatchObject({ kind: "slow" });
    expect(settle(p("start"), running("a"), t0 + START_LIMIT_MS + 5000).kind).toBe("done");
  });

  test("a stop is done when the process is gone, and slow past Crafty's own shutdown timeout", () => {
    expect(settle(p("stop", "a"), running("a"), t0 + 5000).kind).toBe("wait");
    expect(settle(p("stop", "a"), base, t0 + 8000).kind).toBe("done");
    expect(settle(p("stop", "a"), running("a"), t0 + 60_000 + 31_000)).toMatchObject({ kind: "slow" });
    expect(settle(p("kill", "a"), running("a"), t0 + 31_000)).toMatchObject({ kind: "failed" });
  });
});

describe("how often Gluon asks Crafty while a command settles", () => {
  test("asks less and less often the longer it takes", () => {
    const at = (ms: number) => pollDelay(p("start"), { kind: "wait" }, t0 + ms);
    expect([at(1000), at(40_000), at(2 * 60_000), at(4 * 60_000)]).toEqual([2000, 5000, 10_000, 30_000]);
  });

  test("stops asking once it has been slow past five minutes, keeps asking about a slow stop before that", () => {
    const slow = { kind: "slow", message: "" } as const;
    expect(pollDelay(p("stop", "a"), slow, t0 + 100_000)).toBe(10_000);
    expect(pollDelay(p("start"), slow, t0 + START_LIMIT_MS)).toBeNull();
  });

  test("never follows a command forever, and not at all once it failed", () => {
    expect(pollDelay(p("restart", "a"), { kind: "wait" }, t0 + 2 * START_LIMIT_MS)).toBeNull();
    expect(pollDelay(p("start"), { kind: "failed", message: "" }, t0 + 1000)).toBeNull();
  });

  test("the whole of a start that never answers costs a bounded number of polls", () => {
    let polls = 0;
    for (let now = t0; ; polls++) {
      const v = settle(p("start"), starting("a"), now);
      const next = pollDelay(p("start"), v.kind === "done" ? { kind: "wait" } : v, now);
      if (next === null) break;
      now += next;
    }
    // 15 at 2 s, 12 at 5 s, 9 at 10 s, then 30 s until the five-minute message.
    expect(polls).toBeLessThan(45);
  });
});
