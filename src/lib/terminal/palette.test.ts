import { describe, expect, it } from "vitest";
import { paletteCommand } from "./palette";

describe("paletteCommand", () => {
  it.each(["restart jellyfin", "dark", "disk space", "Settings", "", "  ", "what is (this)"])("doesn't offer %j as a command", (q) => {
    expect(paletteCommand(q)).toBeNull();
  });

  it("takes anything after $ or > as a command, strongly", () => {
    expect(paletteCommand("$ uptime")).toEqual({ command: "uptime", strong: true });
    expect(paletteCommand(">free -h")).toEqual({ command: "free -h", strong: true });
  });

  it("is sure when there are flags, pipes or redirects", () => {
    expect(paletteCommand("docker ps -a")).toEqual({ command: "docker ps -a", strong: true });
    expect(paletteCommand("df -h | grep sda")?.strong).toBe(true);
    expect(paletteCommand("./backup.sh --dry-run")?.strong).toBe(true);
  });

  it("offers a known program name weakly", () => {
    expect(paletteCommand("uptime")).toEqual({ command: "uptime", strong: false });
    expect(paletteCommand("free space")?.strong).toBe(false);
  });
});
