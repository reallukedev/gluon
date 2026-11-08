import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A real database with every migration, in a folder of its own.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-auth-"));
process.env.GLUON_DATA = dir;

let db: typeof import("../db");
let users: typeof import("./users");
let setup: typeof import("./setup");
let limits: typeof import("./ratelimit");
let invites: typeof import("./invites");

beforeAll(async () => {
  db = await import("../db");
  users = await import("./users");
  setup = await import("./setup");
  limits = await import("./ratelimit");
  invites = await import("./invites");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function addUser(id: string, role: "admin" | "member", disabled = false) {
  db.run(
    "INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at, disabled) VALUES (?, ?, ?, ?, 'x', ?, ?, ?)",
    id,
    id,
    id,
    role,
    T0,
    T0,
    disabled ? 1 : 0,
  );
}

beforeEach(() => {
  db.run("DELETE FROM users");
  db.run("DELETE FROM login_attempts");
  setup.clearSetupCode();
});

describe("the last admin", () => {
  it("can't be demoted, turned off or removed", () => {
    addUser("maya", "admin");
    addUser("ben", "member");
    expect(() => users.updateProfile("maya", { role: "member" })).toThrow(/at least one admin/);
    expect(() => users.updateProfile("maya", { disabled: true })).toThrow(/at least one admin/);
    expect(() => users.deleteUser("maya")).toThrow(/last admin/);
  });

  it("a turned-off admin isn't the last one, so it can be demoted or removed while another admin remains", () => {
    addUser("maya", "admin");
    addUser("old", "admin", true);
    users.updateProfile("old", { role: "member" });
    expect(users.findById("old")?.role).toBe("member");
    db.run("UPDATE users SET role = 'admin' WHERE id = 'old'");
    users.deleteUser("old");
    expect(users.findById("old")).toBeUndefined();
  });
});

describe("creating accounts", () => {
  it("says the name is taken when another request took it during the password hash", async () => {
    const first = users.createUser({ username: "Sam", displayName: "", role: "member", password: "correct horse 42" });
    const second = users.createUser({ username: "sam", displayName: "", role: "member", password: "correct horse 42" });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "conflict", status: 409 });
  });
});

describe("first-run setup code", () => {
  const file = () => path.join(dir, "setup-code");

  it("is made once and accepted with or without dashes, in any case", () => {
    const code = setup.ensureSetupCode()!;
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(setup.ensureSetupCode()).toBe(code);
    expect(setup.checkSetupCode(code.toLowerCase().replace(/-/g, " "))).toBe(true);
    expect(setup.checkSetupCode(code.slice(0, -1))).toBe(false);
  });

  it("an empty or truncated file is never a code anyone can match", () => {
    fs.writeFileSync(file(), "");
    expect(setup.checkSetupCode("")).toBe(false);
    expect(setup.checkSetupCode("-")).toBe(false);
    fs.writeFileSync(file(), "AB12");
    expect(setup.checkSetupCode("AB12")).toBe(false);
    // and the next start replaces it with a real one
    const code = setup.ensureSetupCode()!;
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(fs.readFileSync(file(), "utf8")).toBe(code);
  });

  it("is gone once someone has an account", () => {
    setup.ensureSetupCode();
    addUser("maya", "admin");
    expect(setup.ensureSetupCode()).toBeNull();
    expect(fs.existsSync(file())).toBe(false);
    expect(setup.checkSetupCode("anything-at-all")).toBe(false);
  });
});

describe("sign-in throttling", () => {
  it("checks one guess at a time per account, so a burst can't all pass the throttle before the first failure counts", async () => {
    let release!: () => void;
    const slow = limits.oneAtATime("login:maya", "away", () => new Promise<void>((r) => (release = r)));
    await expect(limits.oneAtATime("login:MAYA", "away", async () => "second")).rejects.toMatchObject({ status: 429 });
    // Tries from home aren't held up by someone outside.
    await expect(limits.oneAtATime("login:maya", "home", async () => "home")).resolves.toBe("home");
    release();
    await slow;
    await expect(limits.oneAtATime("login:maya", "away", async () => "after")).resolves.toBe("after");
  });

  it("frees the account again when the check throws", async () => {
    await expect(limits.oneAtATime("login:ben", "home", async () => Promise.reject(new Error("wrong")))).rejects.toThrow("wrong");
    await expect(limits.oneAtATime("login:ben", "home", async () => 1)).resolves.toBe(1);
  });

  it("slows an account down after the free failures, in its own zone only", () => {
    for (let i = 0; i < 5; i++) limits.recordAttempt("login:maya", "203.0.113.9", false, "away");
    expect(limits.retryAfter("login:maya", "203.0.113.9", "away")).toBeGreaterThan(0);
    expect(limits.retryAfter("login:maya", "192.168.1.20", "home")).toBe(0);
    limits.recordAttempt("login:maya", "192.168.1.20", true, "home");
    expect(limits.retryAfter("login:maya", "203.0.113.9", "away")).toBe(0);
  });
});

describe("an invite link that no longer works", () => {
  it("says whether it was used or ran out of time", () => {
    addUser("maya", "admin");
    const used = invites.createInvite("member", "Ben", "maya").token;
    const old = invites.createInvite("member", "Lin", "maya").token;
    const open = invites.createInvite("member", "Omar", "maya").token;
    db.run("UPDATE invites SET used_at = ? WHERE token_hash = ?", Date.now(), sha(used));
    db.run("UPDATE invites SET expires_at = ? WHERE token_hash = ?", Date.now() - 1, sha(old));
    expect(invites.peekInvite(used)).toBeNull();
    expect(invites.closedInvite(used)).toBe("used");
    expect(invites.peekInvite(old)).toBeNull();
    expect(invites.closedInvite(old)).toBe("expired");
    expect(invites.peekInvite(open)).not.toBeNull();
    expect(invites.closedInvite(open)).toBeNull();
    expect(invites.closedInvite("never-made-this-one-up")).toBeNull();
  });
});
