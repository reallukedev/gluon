import { describe, expect, test } from "vitest";
import { controlRefusal, editHousehold, entitiesFor, parseAreas, planControl, shownStates, sortPeople, toEntity, toPerson, type HaState } from "./homeassistant-map";

// Shapes as Home Assistant 2026.9 answers GET /api/states (trimmed to the fields that matter).
const states: HaState[] = [
  {
    entity_id: "light.kitchen",
    state: "on",
    attributes: { friendly_name: "Kitchen", brightness: 153, color_mode: "brightness", supported_color_modes: ["brightness"] },
    last_changed: "2026-10-07T07:12:01.512+00:00",
  },
  { entity_id: "cover.garage_door", state: "closed", attributes: { friendly_name: "Garage door", device_class: "garage", current_position: 0 } },
  {
    entity_id: "climate.hallway",
    state: "heat",
    attributes: { friendly_name: "Hallway", hvac_action: "heating", current_temperature: 19.5, temperature: 21, hvac_modes: ["off", "heat"] },
  },
  { entity_id: "binary_sensor.back_door", state: "on", attributes: { friendly_name: "Back door", device_class: "door" } },
  { entity_id: "scene.movie_night", state: "2026-10-06T19:40:00.000+00:00", attributes: { friendly_name: "Movie night", entity_id: ["light.kitchen"] } },
  { entity_id: "sensor.power", state: "1234.56", attributes: { friendly_name: "House power", unit_of_measurement: "W", device_class: "power" } },
  { entity_id: "lock.front_door", state: "unlocked", attributes: { friendly_name: "Front door" } },
  { entity_id: "switch.heater", state: "unavailable", attributes: { friendly_name: "Heater" } },
  {
    entity_id: "camera.porch",
    state: "idle",
    attributes: { friendly_name: "Porch", access_token: "secret-token", entity_picture: "/api/camera_proxy/camera.porch?token=secret-token" },
  },
  { entity_id: "device_tracker.phone", state: "not_home", attributes: { latitude: 52.5, longitude: 13.4 } },
  { entity_id: "Not An Entity", state: "on" } as HaState,
];

const byId = (id: string) => states.find((s) => s.entity_id === id)!;
const opts = { area: "Kitchen", shared: false, press: false, tempUnit: "°C" };

describe("what reaches the browser", () => {
  test("only shown domains pass: cameras (tokens) and device trackers (locations) never do", () => {
    const ids = shownStates(states).map((s) => s.entity_id);
    expect(ids).not.toContain("camera.porch");
    expect(ids).not.toContain("device_tracker.phone");
    expect(ids).not.toContain("Not An Entity");
    expect(ids).toContain("light.kitchen");
  });

  test("attributes are never passed through, only named fields", () => {
    const e = toEntity(byId("scene.movie_night"), opts);
    expect(Object.keys(e).sort()).toEqual(
      ["active", "area", "changedAt", "control", "detail", "domain", "household", "icon", "id", "lastUsedAt", "name", "on", "shared", "target", "unavailable", "unit", "value", "words"].sort(),
    );
  });
});

describe("states in words", () => {
  test.each([
    ["light.kitchen", { words: "On", value: 60, unit: "%", on: true, control: "toggle", icon: "light" }],
    ["cover.garage_door", { words: "Closed", value: null, on: false, control: "cover", icon: "garage" }],
    ["climate.hallway", { words: "Heating", value: 19.5, target: 21, unit: "°C", active: true, control: null }],
    ["binary_sensor.back_door", { words: "Open", active: true, icon: "door", control: null }],
    ["sensor.power", { words: null, value: 1234.56, unit: "W", icon: "power" }],
    ["lock.front_door", { words: "Unlocked", active: true, control: null }],
    ["switch.heater", { words: "Unavailable", unavailable: true, on: null }],
  ])("%s", (id, want) => {
    expect(toEntity(byId(id), opts)).toMatchObject(want);
  });

  test("a scene's state is when it was last used", () => {
    const e = toEntity(byId("scene.movie_night"), opts);
    expect(e).toMatchObject({ control: "run", words: null, lastUsedAt: Date.parse("2026-10-06T19:40:00.000+00:00") });
  });
});

describe("people", () => {
  const image = (p: string) => `/img?p=${p}`;
  const raw: HaState[] = [
    { entity_id: "person.sam", state: "not_home", attributes: { friendly_name: "Sam", entity_picture: "https://evil.example/x.png" } },
    { entity_id: "person.ali", state: "Work", attributes: { friendly_name: "Ali", latitude: 52.5, longitude: 13.4, gps_accuracy: 12 } },
    { entity_id: "person.luke", state: "home", attributes: { friendly_name: "Luke", entity_picture: "/api/image/serve/0123456789abcdef0123456789abcdef/512x512" } },
  ];

  test("by default a named place is just Away: neither the zone name nor coordinates leave the server", () => {
    const list = sortPeople(raw.map((s) => toPerson(s, image)));
    expect(list.map((p) => [p.name, p.where, p.place])).toEqual([
      ["Luke", "home", null],
      ["Ali", "away", null],
      ["Sam", "away", null],
    ]);
    const sent = JSON.stringify(list);
    expect(sent).not.toContain("Work");
    expect(sent).not.toContain("52.5");
  });

  test("with places shown, zones are named; pictures only come from Home Assistant itself", () => {
    const list = sortPeople(raw.map((s) => toPerson(s, image, true)));
    expect(list.map((p) => [p.name, p.where, p.place])).toEqual([
      ["Luke", "home", null],
      ["Ali", "zone", "Work"],
      ["Sam", "away", null],
    ]);
    expect(list[0]!.image).toBe("/img?p=/api/image/serve/0123456789abcdef0123456789abcdef/512x512");
    expect(list[2]!.image).toBeNull();
    expect(JSON.stringify(list)).not.toContain("52.5");
  });

  test("path tricks in a picture are refused", () => {
    expect(toPerson({ entity_id: "person.x", state: "home", attributes: { entity_picture: "/local/../secrets.png" } }, image).image).toBeNull();
  });
});

test("rooms come from the rendered template; malformed answers mean no rooms", () => {
  const map = parseAreas(JSON.stringify([{ id: "kitchen", name: "Kitchen", entities: ["light.kitchen", "sensor.power"] }, { id: "x" }]));
  expect(map.areas).toEqual([{ id: "kitchen", name: "Kitchen", count: 2 }]);
  expect(map.byEntity.get("sensor.power")).toBe("Kitchen");
  expect(parseAreas("TemplateError: nope").areas).toEqual([]);
});

describe("who may press what", () => {
  const allowed = ["light.kitchen", "scene.movie_night"];
  test.each([
    ["admin, any switch", { role: "admin", entityId: "switch.heater", action: "turn_on" }, { ok: true, domain: "switch", service: "turn_on" }],
    ["member, allowed light", { role: "member", entityId: "light.kitchen", action: "turn_off" }, { ok: true, service: "turn_off" }],
    ["member, allowed scene", { role: "member", entityId: "scene.movie_night", action: "run" }, { ok: true, domain: "scene", service: "turn_on" }],
    ["member, not allowed", { role: "member", entityId: "switch.heater", action: "turn_on" }, { ok: false, status: 403 }],
    ["admin, a lock", { role: "admin", entityId: "lock.front_door", action: "turn_on" }, { ok: false, status: 400 }],
    ["member, a lock someone listed", { role: "member", entityId: "lock.front_door", action: "open" }, { ok: false, status: 400 }],
    ["admin, wrong action for the thing", { role: "admin", entityId: "cover.garage_door", action: "turn_on" }, { ok: false, status: 400 }],
    ["admin, cover", { role: "admin", entityId: "cover.garage_door", action: "open" }, { ok: true, service: "open_cover" }],
    ["not an entity", { role: "admin", entityId: "light/../x", action: "turn_on" }, { ok: false, status: 400 }],
    ["not an action", { role: "admin", entityId: "light.kitchen", action: "unlock" }, { ok: false, status: 400 }],
  ] as const)("%s", (_name, input, want) => {
    expect(planControl({ ...input, householdAllowed: [...allowed, "lock.front_door"] })).toMatchObject(want);
  });

  test("the see list takes anything shown; the press list drops look-only things and entrances; deny wins", () => {
    expect(editHousehold("see", ["light.kitchen"], ["lock.front_door", "camera.porch", "BAD"], [])).toEqual(["light.kitchen", "lock.front_door"]);
    const garage = (id: string) => id === "cover.garage_door";
    expect(
      editHousehold("press", ["light.kitchen", "switch.heater"], ["scene.movie_night", "lock.front_door", "cover.garage_door", "cover.blind", "light.kitchen"], ["switch.heater"], (id) => garage(id) || id.startsWith("lock.")),
    ).toEqual(["light.kitchen", "scene.movie_night", "cover.blind"]);
  });

  test.each([
    ["garage", "member", { ok: false, status: 403 }],
    ["gate", "member", { ok: false, status: 403 }],
    ["door", "member", { ok: false, status: 403 }],
    ["blind", "member", { ok: true, service: "open_cover" }],
    ["garage", "admin", { ok: true, service: "open_cover" }],
  ] as const)("a %s cover opened by a %s, even when shared to press", (deviceClass, role, want) => {
    expect(planControl({ role, entityId: "cover.front", action: "open", householdAllowed: ["cover.front"], deviceClass })).toMatchObject(want);
  });
});

describe("what each viewer gets on a Home controls widget", () => {
  const shown = shownStates(states);
  const map = (s: HaState) => toEntity(s, { area: null, shared: false, press: false });
  const only = ["light.kitchen", "lock.front_door", "sensor.does_not_exist"];
  const household = ["light.kitchen"];

  test("a member asking for things that aren't shared learns nothing about them, not even whether they exist", () => {
    const r = entitiesFor({ states: shown, only, role: "member", shared: household, map });
    expect(r.entities.map((e) => e.id)).toEqual(["light.kitchen"]);
    expect(r.notShared).toEqual(["lock.front_door", "sensor.does_not_exist"]);
    expect(r.missing).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("Unlocked");
    expect(JSON.stringify(r)).not.toContain("Front door");
  });

  test("an unknown viewer is treated like a member", () => {
    expect(entitiesFor({ states: shown, only, role: null, shared: household, map }).notShared).toEqual(["lock.front_door", "sensor.does_not_exist"]);
  });

  test("an admin gets everything picked that exists", () => {
    const r = entitiesFor({ states: shown, only, role: "admin", shared: household, map });
    expect(r.entities.map((e) => e.id)).toEqual(["light.kitchen", "lock.front_door"]);
    expect(r.missing).toEqual(["sensor.does_not_exist"]);
    expect(r.notShared).toEqual([]);
  });
});

describe("refused presses are logged", () => {
  test.each([
    ["a member trying a lock", { role: "member", entityId: "lock.front_door", action: "open" }, "invalid"],
    ["a member trying something not shared", { role: "member", entityId: "switch.heater", action: "turn_on" }, "permission"],
    ["an admin with a made-up action", { role: "admin", entityId: "light.kitchen", action: "explode" }, "invalid"],
  ] as const)("%s gets an activity entry", (_name, input, refused) => {
    const plan = planControl({ ...input, householdAllowed: ["light.kitchen"] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    const entry = controlRefusal({ integrationId: "int1", entityId: input.entityId, action: input.action, name: null, status: plan.status, message: plan.message });
    expect(entry).toMatchObject({ action: "integration.control", outcome: "failed", target: input.entityId, detail: { integration: "int1", refused } });
  });

  test("input that failed validation is not copied into the log", () => {
    const junk = "light.x'); DROP TABLE users; -- Bearer eyJhbGciOi";
    const entry = controlRefusal({ integrationId: null, entityId: junk, action: "Bearer abc", name: null, status: 400, message: "That isn't a Home Assistant entity." });
    expect(entry.target).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("Bearer");
    expect(JSON.stringify(entry)).not.toContain("DROP");
  });
});

test("sharing to see doesn't let members press; a garage door shared to press still can't be pressed by them", () => {
  const light = toEntity(byId("light.kitchen"), { area: null, shared: true, press: false });
  expect([light.shared, light.household]).toEqual([true, false]);
  const garage = toEntity(byId("cover.garage_door"), { area: null, shared: false, press: true });
  expect([garage.shared, garage.household]).toEqual([true, false]);
  const lit = toEntity(byId("light.kitchen"), { area: null, shared: false, press: true });
  expect([lit.shared, lit.household]).toEqual([true, true]);
});
