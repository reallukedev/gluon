import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const root = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gluon-grant-scan-")));
});

vi.mock("@/server/host/exec", () => ({
  host: vi.fn(async (_cmd: string, args: string[]) => {
    const p = args[args.length - 1]!;
    const real = fs.realpathSync(path.join(root, p));
    return { stdout: "/" + path.relative(root, real) + "\n" };
  }),
  CommandError: class extends Error {},
}));
vi.mock("@/server/docker/apps", () => ({ getApp: vi.fn(), listApps: vi.fn(), setAppPrefs: vi.fn() }));

fs.mkdirSync(path.join(root, "srv/deep/a/b/c/d/e/.aws"), { recursive: true });
fs.mkdirSync(path.join(root, "srv/linked/files"), { recursive: true });
fs.mkdirSync(path.join(root, "srv/keys/bob/.ssh"), { recursive: true });
fs.symlinkSync(path.join(root, "srv/keys"), path.join(root, "srv/linked/keys-link"));
fs.mkdirSync(path.join(root, "srv/tall", ...Array.from({ length: 40 }, (_, i) => `l${i}`)), { recursive: true });

vi.stubEnv("GLUON_HOST_ROOT", root);
vi.stubEnv("GLUON_DATA", path.join(root, ".gluon-data"));
const { validateGrantPath } = await import("./access");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("validateGrantPath key-folder scan", () => {
  it("names a key folder found several levels down", async () => {
    const e = await refusal(validateGrantPath("/srv/deep"));
    expect(e.code).toBe("unsafe");
    expect(e.message).toContain("/srv/deep/a/b/c/d/e/.aws");
  });

  it("doesn't follow symlinks while scanning", async () => {
    await expect(validateGrantPath("/srv/linked")).resolves.toBe("/srv/linked");
  });

  it("refuses, with a reason, a tree too deep to check", async () => {
    const e = await refusal(validateGrantPath("/srv/tall"));
    expect(e.code).toBe("unsafe");
    expect(e.message).toContain("too many folders");
  });
});
