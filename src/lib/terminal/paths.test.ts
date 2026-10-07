import { describe, expect, it } from "vitest";
import { normalize, resolveDir, shortPath } from "./paths";

describe("resolveDir", () => {
  it("refuses folders it can't know without asking the shell", () => {
    expect(resolveDir("/root", "/root", "$HOME/")).toBeNull();
    expect(resolveDir("/root", "/root", "~luke/")).toBeNull();
    expect(resolveDir("/", null, "~/")).toBeNull();
  });

  it("resolves relative, home and absolute folders", () => {
    expect(resolveDir("/var/lib/prosody", "/root", "")).toBe("/var/lib/prosody");
    expect(resolveDir("/var/lib/prosody", "/root", "../")).toBe("/var/lib");
    expect(resolveDir("/var/lib", "/root", "~/.ssh/")).toBe("/root/.ssh");
    expect(resolveDir("/var", "/root", "/etc//prosody/./")).toBe("/etc/prosody");
  });

  it("never climbs above /", () => {
    expect(normalize("/../../etc")).toBe("/etc");
  });
});

describe("shortPath", () => {
  it("writes home as ~, but not a folder that only starts with the same letters", () => {
    expect(shortPath("/home/luke/apps", "/home/luke")).toBe("~/apps");
    expect(shortPath("/home/lukewarm", "/home/luke")).toBe("/home/lukewarm");
    expect(shortPath("/etc", "/")).toBe("/etc");
  });
});
