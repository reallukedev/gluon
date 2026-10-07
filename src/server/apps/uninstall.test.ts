import { describe, expect, it, vi } from "vitest";

const app = (id: string) => ({ id, name: id, source: "gluon", self: false, kind: "stack", containers: [{ id: "c", name: `${id}-web-1` }], copyOf: null, umbrel: null, gluon: { folder: `/srv/gluon-apps/${id}`, builderId: null, movedFrom: null }, configFile: `/srv/gluon-apps/${id}/docker-compose.yml`, workingDir: `/srv/gluon-apps/${id}` });
const docker = vi.fn();
vi.mock("../docker/apps", () => ({ getApp: async (id: string) => app(id), listApps: async () => [], invalidateApps: () => undefined }));
vi.mock("../docker/client", () => ({ docker: () => docker() }));

describe("uninstall during a move", () => {
  it("refuses the copy a move is still making, before reading anything from Docker", async () => {
    const { lockApps } = await import("./lock");
    const { runUninstall } = await import("./uninstall");
    const move = lockApps(["immich"], "Immich is moving to Gluon");
    move.extend("immich-gluon");
    const user = { id: "u", username: "luke" } as never;
    await expect(runUninstall("immich-gluon", "everything", "0".repeat(20), user, {})).rejects.toThrow("Wait a moment: Immich is moving to Gluon.");
    await expect(runUninstall("immich", "keep", "0".repeat(20), user, {})).rejects.toThrow(/moving to Gluon/);
    expect(docker).not.toHaveBeenCalled();
    move.release();
  });
});

describe("pickRemovals", () => {
  it("deletes exactly what was ticked, and never something the plan keeps", async () => {
    const { pickRemovals } = await import("./uninstall");
    const f = (target: string) => ({ kind: "folder" as const, target, size: null });
    const m = { removes: [f("/a/config")], optional: [f("/a/music")], keeps: [f("/mnt/media")] };
    expect(pickRemovals(m, undefined).map((i) => i.target)).toEqual(["/a/config"]);
    expect(pickRemovals(m, ["/a/music"]).map((i) => i.target)).toEqual(["/a/music"]);
    expect(pickRemovals(m, ["/a/config", "/a/music", "/mnt/media", "/etc"]).map((i) => i.target)).toEqual(["/a/config", "/a/music"]);
  });
});
