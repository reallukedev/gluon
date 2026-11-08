import { describe, expect, it, vi } from "vitest";

/** Crash-loop counting from `docker events`: only deaths nobody asked for, of containers Docker restarts. */

const policies = new Map<string, string>();
const crashed: string[] = [];

vi.mock("./client", () => ({
  docker: () => ({
    getContainer: (id: string) => ({
      inspect: async () => {
        const p = policies.get(id);
        if (p === undefined) throw Object.assign(new Error("no such container"), { statusCode: 404 });
        return { HostConfig: { RestartPolicy: { Name: p } } };
      },
    }),
  }),
}));
vi.mock("./apps", () => ({ invalidateApps: () => undefined }));
vi.mock("../events", () => ({ publish: () => undefined }));
vi.mock("../audit", () => ({ systemEvent: (e: { summary: string }) => crashed.push(e.summary) }));
vi.mock("../jobs", () => ({ onStart: () => undefined }));

const { handleDockerEvent, recentDies } = await import("./events");

let clock = Date.now() - 60_000;
const ev = (id: string, name: string, action: string, attrs: Record<string, string> = {}) => {
  clock += 1000;
  return handleDockerEvent(JSON.stringify({ Action: action, Actor: { ID: id, Attributes: { name, ...attrs } }, timeNano: clock * 1e6 }));
};

describe("docker events", () => {
  it("counts a container that dies on its own and is restarted by Docker", async () => {
    policies.set("a1", "unless-stopped");
    for (let i = 0; i < 3; i++) {
      await ev("a1", "web", "die", { exitCode: "1" });
      await ev("a1", "web", "start");
    }
    expect(recentDies("web")).toBe(3);
    expect(crashed.filter((c) => c.startsWith("web "))).toHaveLength(3);
  });

  it("doesn't count stops and restarts someone asked for, even when the stop had to force-kill", async () => {
    policies.set("b1", "always");
    for (let i = 0; i < 3; i++) {
      await ev("b1", "db", "kill", { signal: "15" });
      await ev("b1", "db", "kill", { signal: "9" });
      await ev("b1", "db", "die", { exitCode: "137" });
      await ev("b1", "db", "start");
    }
    expect(recentDies("db")).toBe(0);
    expect(crashed.some((c) => c.startsWith("db "))).toBe(false);
  });

  it("still counts a crash after a reload signal", async () => {
    policies.set("c1", "always");
    await ev("c1", "proxy", "kill", { signal: "1" });
    await ev("c1", "proxy", "die", { exitCode: "2" });
    expect(recentDies("proxy")).toBe(1);
  });

  it("doesn't call one-off jobs a crash loop", async () => {
    // A scheduled job run again and again: Docker never restarts it itself.
    policies.set("d1", "no");
    for (let i = 0; i < 4; i++) await ev("d1", "backup", "die", { exitCode: "0" });
    expect(recentDies("backup")).toBe(0);
    // on-failure after a clean exit: finished, not restarted.
    policies.set("e1", "on-failure");
    for (let i = 0; i < 4; i++) await ev("e1", "migrate", "die", { exitCode: "0" });
    expect(recentDies("migrate")).toBe(0);
    // Removed straight away (--rm): nothing to restart.
    for (let i = 0; i < 4; i++) await ev("gone", "oneoff", "die", { exitCode: "0" });
    expect(recentDies("oneoff")).toBe(0);
  });
});
