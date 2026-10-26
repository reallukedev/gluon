import { describe, expect, it } from "vitest";
import { trouble } from "./plain";

const c = (line: "running" | "unhealthy" | "stopped", state = line === "stopped" ? "exited" : "running") => ({ name: "x", state, health: null, line });
const app = (containers: ReturnType<typeof c>[], line: "running" | "unhealthy" | "stopped" = "unhealthy") => ({ line, summary: "Unhealthy", containers });

describe("trouble", () => {
  it("says nothing for a healthy or a deliberately stopped app", () => {
    expect(trouble(app([c("running")], "running"))).toBeNull();
    expect(trouble(app([c("stopped")], "stopped"))).toBeNull();
  });

  it("names what is wrong with a one-part app", () => {
    expect(trouble(app([c("unhealthy", "restarting")]))).toBe("Keeps restarting");
    expect(trouble(app([c("unhealthy")]))).toBe("Not responding");
  });

  it("counts parts when only some of an app is wrong", () => {
    expect(trouble(app([c("running"), c("stopped"), c("running"), c("running")]))).toBe("1 of 4 parts stopped");
    expect(trouble(app([c("unhealthy", "restarting"), c("unhealthy", "restarting"), c("running")]))).toBe("2 of 3 parts keep restarting");
    expect(trouble(app([c("unhealthy"), c("running")]))).toBe("1 of 2 parts isn't responding");
  });

  it("leaves old copies to their own note", () => {
    expect(trouble({ ...app([c("unhealthy")]), copyOf: { id: "a" } })).toBeNull();
  });
});
