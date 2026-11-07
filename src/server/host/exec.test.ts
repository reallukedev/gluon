import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { CommandError, local, localSpawn } from "./exec";

// A killed orphan can linger as a zombie when PID 1 doesn't reap, so read its state.
const alive = (pid: number) => {
  try {
    return !/^\d+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

describe("local()", () => {
  it("returns stdout and treats okCodes as success", async () => {
    expect((await local("sh", ["-c", "echo hi"])).stdout).toBe("hi\n");
    await expect(local("sh", ["-c", "exit 1"], { okCodes: [1] })).resolves.toBeDefined();
  });

  it("rejects a nonzero exit with the last stderr lines and the code", async () => {
    const e = await local("sh", ["-c", "echo one >&2; echo two >&2; exit 3"]).catch((x) => x);
    expect(e).toBeInstanceOf(CommandError);
    expect(e.code).toBe(3);
    expect(e.message).toBe("one two");
  });

  it("feeds input and closes stdin when there is none", async () => {
    expect((await local("cat", [], { input: "abc" })).stdout).toBe("abc");
    // Without input, cat sees EOF at once instead of waiting for the timeout.
    expect((await local("cat", [], { timeoutMs: 2000 })).stdout).toBe("");
  });

  it("survives a program that exits without reading its input", async () => {
    await expect(local("true", [], { input: "x".repeat(4 * 1024 * 1024) })).resolves.toBeDefined();
  });

  it("kills the whole process group on timeout and reports a timeout", async () => {
    const e = await local("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 300 }).catch((x) => x);
    expect(e).toBeInstanceOf(CommandError);
    expect(e.message).toMatch(/^Timed out/);
    const pid = Number(e.stdout.trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it("stops a command whose output passes maxBuffer", async () => {
    const e = await local("sh", ["-c", "yes"], { maxBuffer: 64 * 1024, timeoutMs: 5000 }).catch((x) => x);
    expect(e.message).toMatch(/^Output too large/);
  });

  it("rejects a missing program", async () => {
    await expect(local("gluon-no-such-program-xyz")).rejects.toBeInstanceOf(CommandError);
  });
});

describe("localSpawn()", () => {
  it("kill() reaches the children too", async () => {
    const child = localSpawn("sh", ["-c", "sleep 30 & echo $!; wait"]);
    const pid = await new Promise<number>((r) => child.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    const closed = new Promise((r) => child.on("close", r));
    child.kill("SIGTERM");
    await closed;
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });
});
