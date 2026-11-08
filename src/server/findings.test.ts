import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real database with every migration, in a folder of its own.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-findings-"));
process.env.GLUON_DATA = dir;

type Db = typeof import("./db");
type Findings = typeof import("./findings");
type Dispatcher = typeof import("./notify/dispatcher");
let db: Db;
let f: Findings;
let d: Dispatcher;

beforeAll(async () => {
  db = await import("./db");
  f = await import("./findings");
  d = await import("./notify/dispatcher");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  for (const t of ["findings", "notify_deliveries"]) db.run(`DELETE FROM ${t}`);
});
afterEach(() => vi.useRealTimers());

const input = { id: "disk.full:/srv", kind: "disk.full", severity: "attention" as const, subject: "/srv", title: "/srv is 91% full" };

describe("raise() after a resolve", () => {
  it("carries on the same episode when it comes back within the grace period", () => {
    f.raise(input);
    f.markNotified(input.id);
    vi.setSystemTime(T0 + MIN);
    f.resolve(input.id);
    vi.setSystemTime(T0 + 3 * MIN);
    f.raise(input);
    const now = f.getFinding(input.id)!;
    expect(now.resolvedAt).toBeNull();
    expect(now.firstSeen).toBe(T0);
    // Already told about this episode, so no second alert.
    expect(f.needsNotification().map((x) => x.id)).not.toContain(input.id);
  });

  it("starts a new episode once the grace period has passed", () => {
    f.raise(input);
    f.markNotified(input.id);
    f.resolve(input.id);
    vi.setSystemTime(T0 + f.REOPEN_GRACE_MS + MIN);
    f.raise(input);
    const now = f.getFinding(input.id)!;
    expect(now.firstSeen).toBe(T0 + f.REOPEN_GRACE_MS + MIN);
    expect(f.needsNotification().map((x) => x.id)).toContain(input.id);
  });

  it("starts a new episode after it was dismissed", () => {
    f.raise(input);
    f.dismiss(input.id, "u-admin");
    f.resolve(input.id);
    vi.setSystemTime(T0 + MIN);
    f.raise(input);
    expect(f.getFinding(input.id)!.firstSeen).toBe(T0 + MIN);
  });
});

describe("followUps()", () => {
  function sentProblem() {
    db.run(
      `INSERT INTO notify_deliveries (created_at, channel_id, channel_name, channel_kind, event, finding_id, episode, dedupe_key, severity, title, body, status, not_before, next_attempt_at, sent_at)
       VALUES (?, 'ch1', 'Phone', 'ntfy', 'problem', ?, ?, ?, 'attention', 't', 'b', 'sent', ?, ?, ?)`,
      T0,
      input.id,
      T0,
      `ch1|problem|${input.id}|${T0}`,
      T0,
      T0,
      T0,
    );
  }
  const followed = () => db.one<{ followed_up: number }>("SELECT followed_up FROM notify_deliveries")!.followed_up;

  it("waits out the grace period before treating a cleared finding as fixed", () => {
    f.raise(input);
    sentProblem();
    vi.setSystemTime(T0 + MIN);
    f.resolve(input.id);
    d.followUps();
    expect(followed()).toBe(0);
    vi.setSystemTime(T0 + MIN + f.REOPEN_GRACE_MS);
    d.followUps();
    expect(followed()).toBe(1);
  });
});
