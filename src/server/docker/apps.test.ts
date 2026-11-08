import { describe, expect, it, vi } from "vitest";
import type { ContainerSummary } from "./apps";

vi.mock("../platform", () => ({ activePlatform: async () => "none" }));
vi.mock("../platform/umbrel", () => ({}));
vi.mock("../host/exec", () => ({ host: async () => ({ stdout: "" }) }));
vi.mock("../db", () => ({ all: () => [], one: () => undefined, run: () => undefined, now: () => 0 }));
vi.mock("../caddy/routes", () => ({}));
vi.mock("../apps/marker", () => ({ readMarker: () => null }));
vi.mock("./client", () => ({ docker: () => ({}) }));

const { aggregate, containerLine, exitCodeOf } = await import("./apps");

const ctr = (service: string, state: string, status: string, health: ContainerSummary["health"] = null) =>
  ({ id: service, name: `app-${service}-1`, service, state, status, health, line: containerLine(state, health) }) as ContainerSummary;

describe("an app's state in one line", () => {
  it("reads the exit code from the status", () => {
    expect(exitCodeOf("Exited (0) 2 hours ago")).toBe(0);
    expect(exitCodeOf("Exited (137) About a minute ago")).toBe(137);
    expect(exitCodeOf("Up 3 days (healthy)")).toBeNull();
  });

  it("doesn't count a declared one-off job that finished cleanly against the app", () => {
    const cs = [ctr("web", "running", "Up 2 hours"), ctr("migrate", "exited", "Exited (0) 2 hours ago")];
    expect(aggregate(cs, new Set(["migrate"]))).toEqual({ line: "running", summary: "Running" });
    // Undeclared, or failed: it is a stopped part.
    expect(aggregate(cs)).toEqual({ line: "unhealthy", summary: "1 of 2 stopped" });
    const failed = [ctr("web", "running", "Up 2 hours"), ctr("migrate", "exited", "Exited (1) 2 hours ago")];
    expect(aggregate(failed, new Set(["migrate"]))).toEqual({ line: "unhealthy", summary: "1 of 2 stopped" });
    // Everything stopped, the job included: the app is stopped.
    expect(aggregate([ctr("web", "exited", "Exited (0) 1 hour ago"), ctr("migrate", "exited", "Exited (0) 2 hours ago")], new Set(["migrate"])).line).toBe("stopped");
  });

  it("says when only some parts are paused, and when one keeps restarting", () => {
    expect(aggregate([ctr("web", "running", "Up 1 hour"), ctr("db", "paused", "Up 1 hour (Paused)")])).toEqual({ line: "paused", summary: "1 of 2 paused" });
    expect(aggregate([ctr("web", "restarting", "Restarting (1) 5 seconds ago")])).toEqual({ line: "unhealthy", summary: "Restarting over and over" });
    expect(aggregate([ctr("web", "running", "Up 1 minute (unhealthy)", "unhealthy"), ctr("db", "running", "Up 1 hour")])).toEqual({ line: "unhealthy", summary: "1 of 2 unhealthy" });
  });
});
