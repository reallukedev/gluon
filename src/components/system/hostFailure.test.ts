import { describe, expect, it } from "vitest";
import { hostFailure } from "./hostFailure";

describe("hostFailure", () => {
  it("reads a program the host doesn't have as missing, not broken", () => {
    expect(hostFailure({ message: "spawn apt ENOENT", details: { command: "apt list --upgradable" } })).toEqual({ kind: "missing", program: "apt", command: "apt list --upgradable" });
  });

  it("reads nsenter's own wording on the server the same way", () => {
    expect(hostFailure({ message: "nsenter: failed to execute apt: No such file or directory", details: { command: "apt list --upgradable" } })).toMatchObject({ kind: "missing", program: "apt" });
  });

  it("only calls it missing when the missing program is the one that was run", () => {
    expect(hostFailure({ message: "sh: 1: foo: not found", details: { command: "apt list --upgradable" } }).kind).toBe("other");
    expect(hostFailure({ message: "sh: 1: apt: not found", details: { command: "apt list --upgradable" } }).kind).toBe("missing");
  });

  it("treats a timeout as a fault worth retrying", () => {
    expect(hostFailure({ message: "Timed out: systemctl list-units" }).kind).toBe("timeout");
  });

  it("keeps a missing file inside a working program a real failure", () => {
    expect(hostFailure({ message: "E: Could not open lock file /var/lib/dpkg/lock - open (2: No such file or directory)" }).kind).toBe("other");
  });
});
