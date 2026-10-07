import { describe, expect, it } from "vitest";
import { containerFor } from "./container";

const app = (self = false) => ({
  name: self ? "Gluon" : "Immich",
  self,
  containers: [
    { id: "a".repeat(64), shortId: "a".repeat(12), name: "immich_server_1" },
    { id: "b".repeat(64), shortId: "b".repeat(12), name: "immich_postgres_1" },
  ],
});

describe("containerFor", () => {
  it("only finds the app's own containers, by name or id", () => {
    expect(containerFor(app(), "immich_postgres_1", "stop").id).toBe("b".repeat(64));
    expect(containerFor(app(), "b".repeat(12), "stop").name).toBe("immich_postgres_1");
    expect(containerFor(app(), "/immich_server_1", "restart").name).toBe("immich_server_1");
    // Someone else's container, even posted to this app's address, is refused.
    expect(() => containerFor(app(), "jellyfin_server_1", "stop")).toThrow(/doesn't exist/);
    expect(() => containerFor(app(), "bbb", "stop")).toThrow(/doesn't exist/);
  });

  it("lets Gluon's own container restart and nothing else", () => {
    expect(containerFor(app(true), "immich_server_1", "restart").name).toBe("immich_server_1");
    for (const a of ["stop", "pause", "kill"]) expect(() => containerFor(app(true), "immich_server_1", a), a).toThrow(/Restart it instead/);
  });
});
