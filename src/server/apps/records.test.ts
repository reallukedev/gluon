import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A real database with every migration, in a folder of its own.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-records-"));
process.env.GLUON_DATA = dir;

type Db = typeof import("../db");
type Records = typeof import("./records");
let db: Db;
let rec: Records;

beforeAll(async () => {
  db = await import("../db");
  rec = await import("./records");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const MOVED_AT = T0 + 60_000;
const NOW = T0 + 120_000;

function reset() {
  for (const t of ["app_prefs", "app_access", "pins", "home_layouts", "user_prefs", "findings", "monitors", "reports", "announcements", "integrations", "users"]) db.run(`DELETE FROM ${t}`);
  for (const [id, role] of [["u-admin", "admin"], ["u-ana", "member"], ["u-ben", "member"]] as const) {
    db.run("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', ?, ?)", id, id, id, role, T0, T0);
  }
}

const card = (appId: string) => ({ id: `ap-${appId}`, type: "app", size: "i", config: { appId, name: "Immich" } });
const layout = (...items: unknown[]) => JSON.stringify({ version: 1, items });

/** A household app with grants, Home pins and cards, a monitor and a public address. */
function seedImmich() {
  db.run("INSERT INTO app_prefs (app_id, display_name, description, icon, url_home, url_away, household, has_login, hidden, updated_at) VALUES ('immich', 'Photos', NULL, 'https://i/immich.svg', NULL, 'https://photos.example', 1, 'yes', 0, ?)", T0);
  db.run("INSERT INTO app_access (app_id, user_id) VALUES ('immich', 'u-ana'), ('immich', 'u-ben'), ('jellyfin', 'u-ana')");
  db.run("INSERT INTO pins (id, user_id, kind, target, label, position, created_at) VALUES ('p1', 'u-ana', 'app', 'immich', 'Photos', 0, ?), ('p2', 'u-ana', 'folder', '/srv/immich', 'x', 1, ?)", T0, T0);
  db.run("INSERT INTO home_layouts (owner, json, updated_at) VALUES ('u-ana', ?, ?), ('__default__', ?, ?)", layout(card("immich"), card("jellyfin")), T0, layout({ id: "apps", type: "apps", size: "w", config: { show: "selected", ids: ["immich", "jellyfin"] } }), T0);
  db.run("INSERT INTO user_prefs (user_id, json, updated_at) VALUES ('u-ben', ?, ?)", JSON.stringify({ homeApps: ["immich", "jellyfin"] }), T0);
  db.run("INSERT INTO monitors (id, name, kind, target, config, source, ref, enabled, created_at) VALUES ('m-app', 'Immich', 'http', 'http://127.0.0.1:2283/', ?, 'auto', 'app:immich', 0, ?)", JSON.stringify({ app: "immich", intervalSec: 300 }), T0);
  db.run("INSERT INTO monitors (id, name, kind, target, config, source, ref, enabled, created_at) VALUES ('m-route', 'Photos (public)', 'http', 'https://photos.example', ?, 'auto', 'route:r1', 1, ?)", JSON.stringify({ app: "immich" }), T0);
  db.run("INSERT INTO findings (id, kind, severity, subject, title, first_seen, last_seen) VALUES ('monitor.down:m-route', 'monitor.down', 'fault', 'immich', 'Photos is down', ?, ?), ('app.broken:immich_server_1', 'app.broken', 'fault', 'immich', 'x', ?, ?)", T0, T0, T0, T0);
  db.run("INSERT INTO reports (id, user_id, app_id, message, created_at) VALUES ('r-open', 'u-ana', 'immich', 'slow', ?)", T0);
  db.run("INSERT INTO reports (id, user_id, app_id, message, created_at, resolved_at) VALUES ('r-done', 'u-ana', 'immich', 'old', ?, ?)", T0, T0);
}

const routes = { routes: [{ id: "r1", app: "immich" }, { id: "r2", app: "jellyfin" }], fallback: { app: null } };
const move = (from: string, to: string) => rec.planRecordMove(rec.snapshotRecords(from, to, routes, NOW), from, to, { movedAt: MOVED_AT, now: NOW });

/** Everything the plan can touch, for before/after comparisons. */
function dump() {
  return Object.fromEntries(["app_prefs", "app_access", "pins", "home_layouts", "user_prefs", "monitors", "findings", "reports", "announcements", "integrations"].map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));
}

describe("moving an app's records to its new id", () => {
  beforeEach(reset);

  it("hands over settings, grants, Home, monitors and the public address, and leaves the old copy nothing to show members", () => {
    seedImmich();
    const plan = move("immich", "immich-gluon");
    rec.applyRecordPlan(plan);

    const prefs = db.one<{ display_name: string; household: number; has_login: string; url_away: string }>("SELECT * FROM app_prefs WHERE app_id = 'immich-gluon'")!;
    expect(prefs).toMatchObject({ display_name: "Photos", household: 1, has_login: "yes", url_away: "https://photos.example" });
    expect(db.one<{ household: number }>("SELECT household FROM app_prefs WHERE app_id = 'immich'")!.household).toBe(0);
    expect(db.all<{ app_id: string; user_id: string }>("SELECT * FROM app_access ORDER BY app_id, user_id")).toEqual([
      { app_id: "immich-gluon", user_id: "u-ana" },
      { app_id: "immich-gluon", user_id: "u-ben" },
      { app_id: "jellyfin", user_id: "u-ana" },
    ]);
    expect(db.all("SELECT id, target FROM pins ORDER BY id")).toEqual([
      { id: "p1", target: "immich-gluon" },
      { id: "p2", target: "/srv/immich" },
    ]);
    const ana = JSON.parse(db.one<{ json: string }>("SELECT json FROM home_layouts WHERE owner = 'u-ana'")!.json);
    expect(ana.items.map((i: { id: string; config: { appId: string } }) => [i.id, i.config.appId])).toEqual([
      ["ap-immich-gluon", "immich-gluon"],
      ["ap-jellyfin", "jellyfin"],
    ]);
    expect(JSON.parse(db.one<{ json: string }>("SELECT json FROM home_layouts WHERE owner = '__default__'")!.json).items[0].config.ids).toEqual(["immich-gluon", "jellyfin"]);
    expect(JSON.parse(db.one<{ json: string }>("SELECT json FROM user_prefs WHERE user_id = 'u-ben'")!.json).homeApps).toEqual(["immich-gluon", "jellyfin"]);
    // The app's monitor keeps its id, its pause and its interval.
    const m = db.one<{ ref: string; enabled: number; config: string }>("SELECT ref, enabled, config FROM monitors WHERE id = 'm-app'")!;
    expect(m).toMatchObject({ ref: "app:immich-gluon", enabled: 0 });
    expect(JSON.parse(m.config)).toEqual({ app: "immich-gluon", intervalSec: 300 });
    expect(JSON.parse(db.one<{ config: string }>("SELECT config FROM monitors WHERE id = 'm-route'")!.config).app).toBe("immich-gluon");
    // A monitor's finding follows it; one about the old containers stays with the old copy.
    expect(db.all("SELECT id, subject FROM findings ORDER BY id")).toEqual([
      { id: "app.broken:immich_server_1", subject: "immich" },
      { id: "monitor.down:m-route", subject: "immich-gluon" },
    ]);
    expect(db.all("SELECT id, app_id FROM reports ORDER BY id")).toEqual([
      { id: "r-done", app_id: "immich" },
      { id: "r-open", app_id: "immich-gluon" },
    ]);
    expect(plan.routes).toEqual({ ids: ["r1"], fallback: false });
  });

  it("merges into records the new id already has, without duplicates or losing the new app's own choices", () => {
    seedImmich();
    // The new app already has a name, a grant for Ana, a pin and a card for Ana, and a monitor the
    // sync created while the move was running.
    db.run("INSERT INTO app_prefs (app_id, display_name, household, has_login, hidden, updated_at) VALUES ('immich-gluon', 'Immich 2', 0, 'unknown', 0, ?)", T0);
    db.run("INSERT INTO app_access (app_id, user_id) VALUES ('immich-gluon', 'u-ana')");
    db.run("INSERT INTO pins (id, user_id, kind, target, label, position, created_at) VALUES ('p3', 'u-ana', 'app', 'immich-gluon', 'Immich 2', 2, ?)", T0);
    db.run("UPDATE home_layouts SET json = ? WHERE owner = 'u-ana'", layout(card("immich"), card("immich-gluon")));
    db.run("INSERT INTO monitors (id, name, kind, target, config, source, ref, enabled, created_at) VALUES ('m-new', 'Immich', 'http', 'http://127.0.0.1:2283/', ?, 'auto', 'app:immich-gluon', 1, ?)", JSON.stringify({ app: "immich-gluon" }), MOVED_AT + 1000);
    db.run("INSERT INTO findings (id, kind, severity, subject, title, first_seen, last_seen) VALUES ('monitor.down:m-new', 'monitor.down', 'fault', 'immich-gluon', 'down', ?, ?)", MOVED_AT, MOVED_AT);

    rec.applyRecordPlan(move("immich", "immich-gluon"));

    expect(db.one("SELECT display_name, household, has_login FROM app_prefs WHERE app_id = 'immich-gluon'")).toEqual({ display_name: "Immich 2", household: 1, has_login: "yes" });
    expect(db.all("SELECT user_id FROM app_access WHERE app_id = 'immich-gluon' ORDER BY user_id")).toEqual([{ user_id: "u-ana" }, { user_id: "u-ben" }]);
    expect(db.all("SELECT id FROM pins WHERE kind = 'app'")).toEqual([{ id: "p3" }]);
    expect(JSON.parse(db.one<{ json: string }>("SELECT json FROM home_layouts WHERE owner = 'u-ana'")!.json).items.map((i: { id: string }) => i.id)).toEqual(["ap-immich-gluon"]);
    expect(db.all("SELECT id, ref FROM monitors WHERE source = 'auto' AND ref LIKE 'app:%'")).toEqual([{ id: "m-app", ref: "app:immich-gluon" }]);
    expect(db.one<{ resolved_at: number | null }>("SELECT resolved_at FROM findings WHERE id = 'monitor.down:m-new'")!.resolved_at).toBe(NOW);
  });

  it("does nothing the second time, and a later move carries the records on from where they are", () => {
    seedImmich();
    rec.applyRecordPlan(move("immich", "immich-gluon"));
    const after = dump();
    const again = rec.planRecordMove(rec.snapshotRecords("immich", "immich-gluon", { routes: [{ id: "r1", app: "immich-gluon" }] }, NOW), "immich", "immich-gluon", { movedAt: MOVED_AT, now: NOW });
    rec.applyRecordPlan(again);
    expect(dump()).toEqual(after);
    expect(again.routes).toEqual({ ids: [], fallback: false });

    // The moved app is moved again under a new name: everything follows, nothing is left behind.
    rec.applyRecordPlan(rec.planRecordMove(rec.snapshotRecords("immich-gluon", "photos", { routes: [{ id: "r1", app: "immich-gluon" }] }, NOW), "immich-gluon", "photos", { movedAt: MOVED_AT, now: NOW }));
    expect(db.all("SELECT user_id FROM app_access WHERE app_id LIKE 'immich%'")).toEqual([]);
    expect(db.all("SELECT user_id FROM app_access WHERE app_id = 'photos' ORDER BY user_id")).toEqual([{ user_id: "u-ana" }, { user_id: "u-ben" }]);
    expect(db.one<{ target: string }>("SELECT target FROM pins WHERE id = 'p1'")!.target).toBe("photos");
    expect(db.one<{ ref: string }>("SELECT ref FROM monitors WHERE id = 'm-app'")!.ref).toBe("app:photos");
  });

  it("leaves every record as it was when a statement fails partway through", () => {
    seedImmich();
    const before = dump();
    const plan = move("immich", "immich-gluon");
    expect(plan.statements.length).toBeGreaterThan(5);
    // Break it after the grants have been handed over.
    const broken = { ...plan, statements: [...plan.statements.slice(0, 4), { sql: "UPDATE no_such_table SET x = 1", params: [] }, ...plan.statements.slice(4)] };
    expect(() => rec.applyRecordPlan(broken)).toThrow();
    expect(dump()).toEqual(before);
  });

  it("only matches the exact id, not ids that contain it", () => {
    seedImmich();
    db.run("INSERT INTO app_access (app_id, user_id) VALUES ('immich-ml', 'u-ben')");
    db.run("INSERT INTO monitors (id, name, kind, target, config, source, ref, enabled, created_at) VALUES ('m-ml', 'ML', 'http', 'http://x/', ?, 'user', NULL, 1, ?)", JSON.stringify({ app: "immich-ml" }), T0);
    rec.applyRecordPlan(move("immich", "immich-gluon"));
    expect(db.one("SELECT app_id FROM app_access WHERE user_id = 'u-ben' AND app_id = 'immich-ml'")).toEqual({ app_id: "immich-ml" });
    expect(JSON.parse(db.one<{ config: string }>("SELECT config FROM monitors WHERE id = 'm-ml'")!.config).app).toBe("immich-ml");
  });
});

describe("moveLayout", () => {
  it("returns null when the layout doesn't mention the app, so untouched layouts aren't rewritten", async () => {
    const { moveLayout } = await import("./records");
    expect(moveLayout(layout(card("jellyfin")), "immich", "immich-gluon")).toBeNull();
    expect(moveLayout("not json", "immich", "x")).toBeNull();
  });
});
