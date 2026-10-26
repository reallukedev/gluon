import { describe, expect, it } from "vitest";
import { assertFree, assertNoAppWork, lockApps, lockedBy, withAppLock } from "./lock";

describe("app locks", () => {
  it("lets one holder change an app at a time, across both ids of a move", () => {
    const move = lockApps(["immich"], "Immich is moving to Gluon");
    // A second move of the same app, planned while the first plans, is refused.
    expect(() => lockApps(["immich"], "Immich is moving to Gluon")).toThrow("Wait a moment: Immich is moving to Gluon.");
    move.extend("immich-gluon");
    // Starting the copy being made, or the original, waits until the move is done.
    expect(() => assertFree("immich-gluon")).toThrow(/moving to Gluon/);
    expect(() => assertFree("immich")).toThrow(/moving to Gluon/);
    expect(() => assertFree("immich", move)).not.toThrow();
    expect(() => lockApps(["jellyfin", "immich-gluon"], "x")).toThrow();
    // A refused lock takes nothing: jellyfin stays free.
    expect(lockedBy("jellyfin")).toBeNull();
    move.release();
    expect(lockedBy("immich")).toBeNull();
    expect(lockedBy("immich-gluon")).toBeNull();
  });

  it("releases when the work throws, and an old holder can't release a newer lock", async () => {
    await expect(withAppLock(["db"], "db is updating", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(lockedBy("db")).toBeNull();
    const a = lockApps(["db"], "a");
    a.release();
    const b = lockApps(["db"], "b");
    a.release();
    expect(lockedBy("db")).toBe("b");
    b.release();
  });

  it("can't extend onto an app someone else holds", () => {
    const other = lockApps(["photos"], "Photos is being uninstalled");
    const move = lockApps(["immich"], "Immich is moving to Gluon");
    expect(() => move.extend("photos")).toThrow(/uninstalled/);
    move.release();
    other.release();
  });
});

it("server-wide cleanups wait while any app is moving or uninstalling", () => {
  expect(() => assertNoAppWork("remove unused volumes")).not.toThrow();
  const l = lockApps(["immich"], "Immich is moving to Gluon");
  expect(() => assertNoAppWork("remove unused volumes")).toThrow(/Immich is moving to Gluon/);
  l.release();
  expect(() => assertNoAppWork("remove unused volumes")).not.toThrow();
});
