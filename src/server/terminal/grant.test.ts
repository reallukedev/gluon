import { describe, expect, it, vi } from "vitest";

let clock = 0;
vi.mock("../auth/session", () => ({ hasRecentAuth: (s: { recentAuthAt: number }) => clock - s.recentAuthAt < 10 * 60_000 }));
const { requireTerminalAuth } = await import("./grant");

const MIN = 60_000;
const session = (recentAuthAt: number, idHash = "s1") => ({ idHash, recentAuthAt }) as never;
const run = (s: never, at: number) => {
  clock = at;
  requireTerminalAuth(s, at);
};

describe("terminal re-auth grant", () => {
  it("keeps a busy session going past the 10-minute window, then stops after 30 idle minutes", () => {
    const s = session(0, "busy");
    run(s, 1 * MIN);
    run(s, 25 * MIN);
    run(s, 50 * MIN);
    expect(() => run(s, 81 * MIN)).toThrow(/Confirm it's you/);
  });

  it("never lasts more than 4 hours from the re-auth, however busy", () => {
    const s = session(0, "long");
    for (let t = 1; t < 240; t += 20) run(s, t * MIN);
    expect(() => run(s, 241 * MIN)).toThrow(/Confirm it's you/);
  });

  it("gives nothing to a session that never confirmed it's them recently", () => {
    expect(() => run(session(-60 * MIN, "stale"), 0)).toThrow(/Confirm it's you/);
  });

  it("is per sign-in session", () => {
    run(session(0, "a"), 1 * MIN);
    expect(() => run(session(-60 * MIN, "b"), 2 * MIN)).toThrow();
  });
});
