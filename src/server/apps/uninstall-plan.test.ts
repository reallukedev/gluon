import { describe, expect, it } from "vitest";
import { buildUninstallPlan, deletable, type UninstallInput } from "./uninstall-plan";
import type { RuntimeMount, VolumeInfo } from "./rewrite";
import { within } from "./paths";

const bind = (source: string, destination: string): RuntimeMount => ({ type: "bind", source, destination, rw: true });
const named = (name: string, destination: string): RuntimeMount => ({ type: "volume", name, source: `/var/lib/docker/volumes/${name}/_data`, destination, rw: true });
const vol = (name: string, usedBy: string[]): VolumeInfo => ({ name, mountpoint: `/var/lib/docker/volumes/${name}/_data`, driver: "local", hasOptions: false, usedBy });

function base(over: Partial<UninstallInput>): UninstallInput {
  return {
    appId: "x",
    name: "X",
    source: "compose",
    project: "x",
    configFiles: [],
    workingDir: null,
    containers: [],
    projectVolumes: [],
    volumes: [],
    gluonFolder: null,
    appsRoots: ["/srv/gluon-apps", "/DATA/AppData/gluon-apps"],
    runFiles: [],
    casaDataDirs: [],
    binds: [],
    sizes: new Map(),
    ...over,
  };
}

const targets = (items: { target: string }[]) => items.map((i) => i.target);

/** Every path a plan would delete sits inside one of the app's own folders. */
function assertContained(p: ReturnType<typeof buildUninstallPlan>, own: string[]) {
  for (const m of [p.keep, p.everything]) for (const i of m.removes) if (i.kind !== "volume") expect(own.some((o) => within(i.target, o)), i.target).toBe(true);
}

describe("buildUninstallPlan", () => {
  it("Gluon-run app: keeping data removes only the run files; everything removes the folder and its private volumes", () => {
    const folder = "/srv/gluon-apps/immich";
    const p = buildUninstallPlan(
      base({
        appId: "immich",
        source: "gluon",
        project: "immich",
        configFiles: [`${folder}/docker-compose.yml`],
        workingDir: folder,
        gluonFolder: folder,
        runFiles: ["docker-compose.yml", ".env", ".gluon-app"],
        containers: [
          { name: "immich-server-1", mounts: [bind(`${folder}/data/upload`, "/data"), bind("/mnt/photos", "/photos"), named("immich_cache", "/cache"), named("shared_models", "/models")] },
        ],
        projectVolumes: [vol("immich_cache", ["immich-server-1"]), vol("shared_models", ["immich-server-1", "photoprism"])],
        volumes: [vol("immich_cache", ["immich-server-1"]), vol("shared_models", ["immich-server-1", "photoprism"])],
      }),
    );
    expect(targets(p.keep.removes)).toEqual([`${folder}/docker-compose.yml`, `${folder}/.env`, `${folder}/.gluon-app`]);
    expect(targets(p.everything.removes)).toEqual(["immich_cache", folder]);
    // A volume another app uses, and a folder from elsewhere, stay in both modes.
    for (const m of [p.keep, p.everything]) expect(targets(m.keeps)).toEqual(expect.arrayContaining(["shared_models", "/mnt/photos"]));
    expect(p.via).toBe("compose");
    assertContained(p, [folder]);
  });

  it("never deletes a Gluon folder that isn't one level inside an apps folder", () => {
    for (const folder of ["/srv/gluon-apps", "/home/luke/immich", "/srv/gluon-apps/a/b", "/"]) {
      const p = buildUninstallPlan(base({ source: "gluon", gluonFolder: folder, runFiles: ["docker-compose.yml"], configFiles: [`${folder}/docker-compose.yml`] }));
      expect(p.everything.removes, folder).toEqual([]);
      expect(p.keep.removes, folder).toEqual([]);
    }
  });

  it("plain compose: deletes data folders inside the project, never the project folder, its compose file or anything outside", () => {
    const wd = "/home/luke/proxy";
    const p = buildUninstallPlan(
      base({
        appId: "proxy",
        project: "proxy",
        configFiles: [`${wd}/compose.yaml`],
        workingDir: wd,
        containers: [
          { name: "caddy", mounts: [bind(`${wd}/caddy`, "/etc/caddy"), bind(`${wd}/data/certs`, "/certs"), bind(wd, "/src"), bind("/var/run/docker.sock", "/var/run/docker.sock"), bind("/home/luke/media", "/media")] },
        ],
      }),
    );
    expect(targets(p.everything.removes).sort()).toEqual([`${wd}/caddy`, `${wd}/data/certs`]);
    expect(p.keep.removes).toEqual([]);
    expect(targets(p.everything.keeps)).toEqual(expect.arrayContaining([wd, "/var/run/docker.sock", "/home/luke/media"]));
    assertContained(p, [wd]);
  });

  it("plain compose in a folder that holds more than the app: nothing on disk is deletable", () => {
    const p = buildUninstallPlan(base({ workingDir: "/home/luke", configFiles: ["/home/luke/docker-compose.yml"], containers: [{ name: "a", mounts: [bind("/home/luke/appdata", "/data")] }] }));
    expect(p.everything.removes).toEqual([]);
    expect(targets(p.everything.keeps)).toEqual(["/home/luke/appdata"]);
  });

  it("CasaOS: always forgets CasaOS's app folder, deletes /DATA/AppData only when asked, keeps the media library", () => {
    const p = buildUninstallPlan(
      base({
        appId: "jellyfin",
        source: "casaos",
        project: "jellyfin",
        configFiles: ["/var/lib/casaos/apps/jellyfin/docker-compose.yml"],
        workingDir: "/var/lib/casaos/apps/jellyfin",
        casaDataDirs: ["/DATA/AppData/jellyfin", "/DATA/AppData", "/DATA/AppData/jellyfin/config"],
        containers: [{ name: "jellyfin", mounts: [bind("/DATA/AppData/jellyfin/config", "/config"), bind("/mnt/hdd1/media", "/Media")] }],
      }),
    );
    expect(targets(p.keep.removes)).toEqual(["/var/lib/casaos/apps/jellyfin"]);
    expect(targets(p.everything.removes)).toEqual(["/var/lib/casaos/apps/jellyfin", "/DATA/AppData/jellyfin"]);
    expect(targets(p.everything.keeps)).toContain("/mnt/hdd1/media");
    expect(targets(p.everything.keeps)).not.toContain("/DATA/AppData/jellyfin/config");
  });

  it("single container: deletes only volumes no other container mounts, never its bind mounts", () => {
    const anon = "b".repeat(64);
    const p = buildUninstallPlan(
      base({
        source: "docker",
        project: null,
        containers: [{ name: "wiki", mounts: [named(anon, "/var/lib/wiki"), named("caddy_admin", "/run/caddy"), bind("/opt/wiki", "/config")] }],
        volumes: [vol(anon, ["wiki"]), vol("caddy_admin", ["wiki", "caddy"])],
      }),
    );
    expect(p.via).toBe("containers");
    expect(targets(p.everything.removes)).toEqual([anon]);
    expect(targets(p.keep.removes)).toEqual([]);
    expect(targets(p.everything.keeps)).toEqual(["caddy_admin", "/opt/wiki"]);
  });

  it("gives both modes the same id until what they'd remove changes", () => {
    const a = buildUninstallPlan(base({ containers: [{ name: "a", mounts: [] }] }));
    const sized = buildUninstallPlan(base({ containers: [{ name: "a", mounts: [] }], sizes: new Map([["x", 5]]) }));
    const more = buildUninstallPlan(base({ containers: [{ name: "a", mounts: [] }, { name: "b", mounts: [] }] }));
    expect(sized.id).toBe(a.id);
    expect(more.id).not.toBe(a.id);
  });
});

describe("buildUninstallPlan: folders other apps use", () => {
  it("keeps a project folder another container mounts at, below or above it, and still deletes the private ones", () => {
    const wd = "/opt/arr";
    const p = buildUninstallPlan(
      base({
        appId: "arr",
        project: "arr",
        configFiles: [`${wd}/docker-compose.yml`],
        workingDir: wd,
        containers: [{ name: "sonarr", mounts: [bind(`${wd}/downloads`, "/downloads"), bind(`${wd}/config`, "/config"), bind(`${wd}/cache`, "/cache")] }],
        binds: [
          { source: `${wd}/downloads`, container: "sonarr" },
          { source: `${wd}/downloads/movies`, container: "radarr" },
          { source: `${wd}/cache`, container: "qbittorrent" },
          { source: "/", container: "glances" },
        ],
      }),
    );
    expect(targets(p.everything.removes)).toEqual([`${wd}/config`]);
    const kept = Object.fromEntries(p.everything.keeps.map((k) => [k.target, k.note]));
    expect(kept[`${wd}/downloads`]).toBe("Also used by radarr");
    expect(kept[`${wd}/cache`]).toBe("Also used by qbittorrent");
  });

  it("won't delete a Gluon app's folder (or its run files) while a file browser mounts the apps folder above it", () => {
    const folder = "/srv/gluon-apps/immich";
    const p = buildUninstallPlan(
      base({
        source: "gluon",
        gluonFolder: folder,
        runFiles: ["docker-compose.yml"],
        configFiles: [`${folder}/docker-compose.yml`],
        containers: [{ name: "immich-server-1", mounts: [bind(`${folder}/data`, "/data")] }],
        binds: [{ source: "/srv/gluon-apps", container: "filebrowser" }],
      }),
    );
    expect(p.everything.removes).toEqual([]);
    expect(p.keep.removes).toEqual([]);
    expect(p.everything.keeps.find((k) => k.target === folder)?.note).toBe("Also used by filebrowser");
  });

  it("CasaOS: a second install never gets the first one's data folder, even with the same store id", () => {
    const p = buildUninstallPlan(
      base({
        appId: "jellyfin-2",
        source: "casaos",
        project: "jellyfin-2",
        configFiles: ["/var/lib/casaos/apps/jellyfin-2/docker-compose.yml"],
        casaDataDirs: ["/DATA/AppData/jellyfin-2", "/DATA/AppData/jellyfin"],
        containers: [{ name: "jellyfin-2", mounts: [bind("/DATA/AppData/jellyfin-2/config", "/config")] }],
      }),
    );
    expect(targets(p.everything.removes)).toEqual(["/var/lib/casaos/apps/jellyfin-2", "/DATA/AppData/jellyfin-2"]);
    for (const m of [p.keep, p.everything]) expect(JSON.stringify(m)).not.toContain('"/DATA/AppData/jellyfin"');
  });

  it("reads paths after normalising them, so ../ can't walk out of CasaOS's apps folder", () => {
    const p = buildUninstallPlan(
      base({
        source: "casaos",
        configFiles: ["/var/lib/casaos/apps/../x.yml"],
        casaDataDirs: ["/DATA/AppData/../../etc"],
        containers: [{ name: "x", mounts: [bind("/etc/x", "/x")] }],
      }),
    );
    expect(p.everything.removes).toEqual([]);
    expect(p.keep.removes).toEqual([]);
  });
});

describe("buildUninstallPlan: libraries and what the new copy needs", () => {
  const wd = "/home/luke/jelly";
  const input = (sizes: [string, number][] = []) =>
    base({
      appId: "jelly",
      project: "jelly",
      configFiles: [`${wd}/compose.yaml`],
      workingDir: wd,
      containers: [{ name: "jelly", mounts: [bind(`${wd}/config`, "/config"), bind(`${wd}/library`, "/data/movies"), bind(`${wd}/music`, "/srv"), bind(`${wd}/cache`, "/cache")] }],
      sizes: new Map(sizes),
    });

  it("keeps media libraries and big folders out of delete-everything unless ticked one by one", () => {
    const p = buildUninstallPlan(input([[`${wd}/cache`, 80e9]]));
    expect(targets(p.everything.removes)).toEqual([`${wd}/config`]);
    expect(p.everything.optional.map((i) => [i.target, i.note])).toEqual([
      [`${wd}/library`, "Looks like a movies library"],
      [`${wd}/music`, "Looks like a music library"],
      [`${wd}/cache`, "Holds 80 GB"],
    ]);
    expect(p.keep.optional).toEqual([]);
  });

  it("keeps the same id whether or not a folder's size crossed the line", () => {
    expect(buildUninstallPlan(input([[`${wd}/cache`, 80e9]])).id).toBe(buildUninstallPlan(input()).id);
  });

  it("won't delete CasaOS's app folder while the moved copy's compose file still points into it", () => {
    const p = buildUninstallPlan(
      base({
        appId: "wiki",
        source: "casaos",
        project: "wiki",
        configFiles: ["/var/lib/casaos/apps/wiki/docker-compose.yml"],
        containers: [{ name: "wiki", mounts: [] }],
        binds: [{ source: "/var/lib/casaos/apps/wiki/.env", container: "Wiki" }],
      }),
    );
    expect(p.keep.removes).toEqual([]);
    expect(p.everything.removes).toEqual([]);
    expect(p.keep.keeps.find((k) => k.target === "/var/lib/casaos/apps/wiki")?.note).toBe("Also used by Wiki");
  });
});

describe("deletable", () => {
  it("allows only paths inside a folder that is itself specific to one app", () => {
    expect(deletable("/srv/gluon-apps/immich/data", "/srv/gluon-apps/immich")).toBe(true);
    expect(deletable("/srv/gluon-apps/immich/../jellyfin", "/srv/gluon-apps/immich")).toBe(false);
    expect(deletable("/srv/gluon-apps", "/srv/gluon-apps")).toBe(false);
    expect(deletable("/home/luke", "/home/luke")).toBe(false);
    expect(deletable("/mnt/hdd1/media", "/mnt/hdd1")).toBe(false);
    expect(deletable("/DATA/AppData", "/DATA/AppData")).toBe(false);
    expect(deletable("relative/path", "/srv/gluon-apps/x")).toBe(false);
  });
});
