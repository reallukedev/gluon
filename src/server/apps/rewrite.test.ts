import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { rewriteCompose, type RewriteInput, type ServiceRuntime, type VolumeInfo } from "./rewrite";
import { interpolate, learnVars } from "./vars";

const fixture = (f: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", f), "utf8");
const parse = (s: string) => YAML.parse(s) as { name: string; services: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown>; networks?: Record<string, unknown>; "x-gluon"?: Record<string, unknown> };
const env = (text: string | null) => Object.fromEntries((text ?? "").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^'|'$/g, "")]));

const UMBREL = "/srv/umbrel";
const NEW = "/srv/gluon-apps";

function umbrelInput(appId: string, text: string, runtime: ServiceRuntime[], over: Partial<RewriteInput> = {}): RewriteInput {
  const appData = `${UMBREL}/app-data/${appId}`;
  return {
    source: "umbrel",
    appId,
    project: appId,
    newProject: appId,
    newDir: `${NEW}/${appId}`,
    composeText: text,
    workingDir: appData,
    ownDirs: [{ path: appData, to: "" }],
    vars: { APP_DATA_DIR: appData, UMBREL_ROOT: UMBREL, DEVICE_HOSTNAME: "umbrel", DEVICE_DOMAIN_NAME: "umbrel.local" },
    newVars: { APP_DATA_DIR: `${NEW}/${appId}` },
    runtime,
    volumes: [],
    appContainers: runtime.map((r) => r.container),
    meta: { name: appId, icon: null, description: null, webPort: null, path: null },
    umbrel: { proxyPort: null, dependencies: [], hooks: [] },
    ...over,
  };
}

describe("rewriteCompose: Umbrel apps", () => {
  it("publishes Jellyfin's proxied port on the app itself, copies its config and leaves Downloads in place", () => {
    const r = rewriteCompose(
      umbrelInput(
        "jellyfin",
        fixture("umbrel-jellyfin.yml"),
        [
          {
            service: "server",
            container: "jellyfin_server_1",
            hostname: "umbrel",
            env: ["PUID=1000", "PGID=1000"],
            mounts: [
              { type: "bind", source: "/srv/umbrel/app-data/jellyfin/data/config", destination: "/config", rw: true },
              { type: "bind", source: "/srv/umbrel/home/Downloads", destination: "/downloads", rw: true },
            ],
          },
        ],
        { umbrel: { proxyPort: 8096, dependencies: [], hooks: ["pre-start"] }, meta: { name: "Jellyfin", icon: "https://x/icon.svg", description: null, webPort: 8096, path: null } },
      ),
    );
    expect(r.blockers).toEqual([]);
    const doc = parse(r.compose);
    expect(Object.keys(doc.services)).toEqual(["server"]);
    const server = doc.services.server!;
    expect(server.container_name).toBeUndefined();
    expect(server.ports).toEqual(["7359:7359/udp", "8096:8096"]);
    expect(server.volumes).toEqual(["./data/config:/config", "/srv/umbrel/home/Downloads:/downloads"]);
    expect(server.networks).toEqual({ default: { aliases: ["jellyfin_server_1"] } });
    expect(doc.name).toBe("jellyfin");
    expect(r.copies).toEqual([{ from: "/srv/umbrel/app-data/jellyfin/data/config", to: "/srv/gluon-apps/jellyfin/data/config", kind: "folder", services: ["server"] }]);
    expect(r.stays).toEqual([{ path: "/srv/umbrel/home/Downloads", services: ["server"], readOnly: false }]);
    // ${DEVICE_HOSTNAME} still reads from a variable, now set in the new folder's .env.
    expect(env(r.envText)).toEqual({ DEVICE_HOSTNAME: "umbrel" });
    expect(r.ports.map((p) => `${p.host}/${p.proto}`)).toEqual(["7359/udp", "8096/tcp"]);
    expect(r.warnings.some((w) => w.includes("hooks/pre-start"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("login"))).toBe(false); // PROXY_AUTH_ADD: 'false'
    expect(doc["x-gluon"]).toMatchObject({ name: "Jellyfin", icon: "https://x/icon.svg", moved_from: { source: "umbrel", id: "jellyfin" } });
  });

  it("recovers APP_SEED from the running containers and keeps Immich's services able to find each other", () => {
    const seed = "a1b2c3d4e5";
    const svc = (service: string, dest: string, folder: string): ServiceRuntime => ({
      service,
      container: `immich_${service}_1`,
      hostname: "umbrel",
      env: [`JWT_SECRET=${seed}`, "DB_HOSTNAME=immich_postgres_1"],
      mounts: [{ type: "bind", source: `/srv/umbrel/app-data/immich/data/${folder}`, destination: dest, rw: true }],
    });
    const r = rewriteCompose(
      umbrelInput("immich", fixture("umbrel-immich.yml"), [svc("server", "/data", "upload"), svc("machine-learning", "/cache", "model-cache"), svc("redis", "/data", "redis"), svc("postgres", "/var/lib/postgresql/data", "postgres")], {
        newProject: "immich-gluon",
        newDir: `${NEW}/immich-gluon`,
        newVars: { APP_DATA_DIR: `${NEW}/immich-gluon` },
        umbrel: { proxyPort: 2283, dependencies: [], hooks: [] },
      }),
    );
    expect(r.blockers).toEqual([]);
    const doc = parse(r.compose);
    expect(doc.services.app_proxy).toBeUndefined();
    expect(doc.services.server!.ports).toEqual(["2283:2283"]);
    expect(doc.services.server!.depends_on).toEqual(["redis", "postgres"]);
    expect(doc.services.postgres!.networks).toEqual({ default: { aliases: ["immich_postgres_1"] } });
    expect(env(r.envText).APP_SEED).toBe(seed);
    expect(r.copies.map((c) => c.to).sort()).toEqual(["model-cache", "postgres", "redis", "upload"].map((f) => `/srv/gluon-apps/immich-gluon/data/${f}`));
    expect(r.stays).toEqual([]);
  });

  it("refuses an app that leans on another Umbrel app, and names variables it can't resolve", () => {
    const text = `services:\n  app_proxy:\n    environment:\n      APP_HOST: lnd_web_1\n      APP_PORT: 3000\n  web:\n    image: lnd\n    container_name: lnd_web_1\n    environment:\n      BITCOIN_HOST: \${APP_BITCOIN_NODE_IP}\n    volumes:\n      - \${APP_DATA_DIR}/data:/data\n`;
    const r = rewriteCompose(umbrelInput("lnd", text, [], { umbrel: { proxyPort: 2101, dependencies: ["bitcoin"], hooks: [] } }));
    expect(r.blockers.some((b) => b.includes("bitcoin"))).toBe(true);
    expect(r.blockers.some((b) => b.includes("APP_BITCOIN_NODE_IP"))).toBe(true);
    // Umbrel's login guarded it (PROXY_AUTH_ADD wasn't turned off): say so, with the port.
    expect(r.warnings.some((w) => w.includes("login") && w.includes("port 2101"))).toBe(true);
  });

  it("doesn't warn about Umbrel's login when every path was let through anyway", () => {
    const text = `services:\n  app_proxy:\n    environment:\n      APP_HOST: web_1\n      APP_PORT: 80\n      PROXY_AUTH_WHITELIST: "*"\n  web:\n    image: nginx\n    container_name: web_1\n`;
    const r = rewriteCompose(umbrelInput("site", text, [], { umbrel: { proxyPort: 8088, dependencies: [], hooks: [] } }));
    expect(parse(r.compose).services.web!.ports).toEqual(["8088:80"]);
    expect(r.warnings.some((w) => w.includes("login"))).toBe(false);
  });

  it("leaves a host-network app's ports alone and keeps device paths in place", () => {
    const r = rewriteCompose(
      umbrelInput("home-assistant", fixture("umbrel-home-assistant.yml"), [
        {
          service: "server",
          container: "home-assistant_server_1",
          env: [],
          mounts: [
            { type: "bind", source: "/srv/umbrel/app-data/home-assistant/data", destination: "/config", rw: true },
            { type: "bind", source: "/srv/umbrel/home/Downloads", destination: "/media", rw: true },
            { type: "bind", source: "/dev", destination: "/dev", rw: true },
            { type: "bind", source: "/run/dbus", destination: "/run/dbus", rw: false },
          ],
        },
      ]),
    );
    const s = parse(r.compose).services.server!;
    expect(s.network_mode).toBe("host");
    expect(s.networks).toBeUndefined();
    expect(s.ports).toBeUndefined();
    expect(r.copies.map((c) => c.from)).toEqual(["/srv/umbrel/app-data/home-assistant/data"]);
    expect(r.stays.map((x) => [x.path, x.readOnly])).toEqual([
      ["/srv/umbrel/home/Downloads", false],
      ["/dev", false],
      ["/run/dbus", true],
    ]);
  });

  it("copies Umbrel env files and build contexts from the app's folder and keeps a disk elsewhere in place", () => {
    const music = "/mnt/hdd1_ST2000DM001-1ER164/media/music";
    // Umbrel's proxy served Octo on 5275 (behind Umbrel's login); Octo also publishes 5274 itself.
    const r = rewriteCompose(umbrelInput("leech-octo", fixture("umbrel-octo.yml"), [], { umbrel: { proxyPort: 5275, dependencies: [], hooks: [] }, meta: { name: "Octo", icon: null, description: null, webPort: 5275, path: "/admin" } }));
    expect(r.blockers).toEqual([]);
    const doc = parse(r.compose);
    expect(doc.services["yt-dlp-shim"]!.build).toBe("./yt-dlp-shim");
    expect(doc.services.octo!.env_file).toEqual([{ path: "./data/octo.env", required: false }]);
    expect(doc.services.octo!.ports).toEqual(["5274:8080", "5275:8080"]);
    // Its app_proxy never turned Umbrel's login off, so the warning names the port that loses it.
    expect(r.warnings.filter((w) => w.includes("login"))).toEqual([
      "Umbrel asked for its login before opening Octo on port 5275. The copy answers on port 5275 directly, so anyone on your home network can open it without that login; only Octo's own login, if it has one, protects it.",
    ]);
    expect(r.loginLostPort).toBe(5275);
    expect(r.stays.map((s) => s.path)).toEqual([music]);
    expect(r.stays[0]!.services.sort()).toEqual(["navidrome", "octo", "slskd", "yt-dlp-shim"]);
    expect(r.copies.every((c) => c.to.startsWith("/srv/gluon-apps/leech-octo/"))).toBe(true);
    expect(r.copies.some((c) => c.from === "/srv/umbrel/app-data/leech-octo/yt-dlp-shim")).toBe(true);
  });
});

describe("rewriteCompose: CasaOS and plain compose", () => {
  it("drops CasaOS's runtime bits, copies /DATA/AppData and leaves the photo library where it is", () => {
    const r = rewriteCompose({
      source: "casaos",
      appId: "big-bear-immich",
      project: "big-bear-immich",
      newProject: "immich",
      newDir: "/DATA/AppData/gluon-apps/immich",
      composeText: fixture("casaos-big-bear-immich.yml"),
      workingDir: "/var/lib/casaos/apps/big-bear-immich",
      ownDirs: [{ path: "/DATA/AppData/big-bear-immich", to: "data" }],
      vars: {},
      runtime: [],
      volumes: [],
      appContainers: [],
      meta: { name: "Immich", icon: "https://cdn/immich.png", description: "Immich", webPort: 2283, path: null },
    });
    expect(r.blockers).toEqual([]);
    const doc = parse(r.compose);
    expect(r.compose).not.toContain("x-casaos");
    expect(doc.name).toBe("immich");
    expect(doc.networks).toEqual({ big_bear_immich_network: { driver: "bridge" } });
    expect(doc.services.database!.networks).toEqual({ big_bear_immich_network: { aliases: ["immich-postgres"] } });
    expect(doc.services.database!.volumes).toEqual([{ type: "bind", source: "./data/pgdata", target: "/var/lib/postgresql/data", bind: { create_host_path: true } }]);
    expect(r.stays.map((s) => s.path)).toEqual(["/mnt/hdd2/data/photos/upload"]);
    expect(r.copies.map((c) => [c.from, c.to])).toEqual([
      ["/DATA/AppData/big-bear-immich/pgdata", "/DATA/AppData/gluon-apps/immich/data/pgdata"],
      ["/DATA/AppData/big-bear-immich/model-cache", "/DATA/AppData/gluon-apps/immich/data/model-cache"],
    ]);
    expect(doc["x-gluon"]).toMatchObject({ name: "Immich", port: 2283 });
  });

  it("copies what a CasaOS file names relative to CasaOS's app folder, which goes when the old copy is removed", () => {
    const casa = "/var/lib/casaos/apps/wiki";
    const dotenv = "WIKI_SECRET=REDACTED\n";
    const r = rewriteCompose({
      source: "casaos",
      appId: "wiki",
      project: "wiki",
      newProject: "wiki",
      newDir: "/srv/gluon-apps/wiki",
      composeText: "name: wiki\nservices:\n  wiki:\n    image: wiki\n    env_file: .env\n    volumes:\n      - ./data:/data\n      - ./wiki.conf:/etc/wiki.conf:ro\n      - /DATA/AppData/wiki/db:/db\nx-casaos:\n  title:\n    en_US: Wiki\n",
      workingDir: casa,
      ownDirs: [
        { path: "/DATA/AppData/wiki", to: "data" },
        { path: casa, to: "" },
      ],
      vars: {},
      dotenvText: dotenv,
      runtime: [],
      volumes: [],
      appContainers: ["wiki"],
      meta: { name: "Wiki", icon: null, description: null, webPort: null, path: null },
    });
    expect(r.blockers).toEqual([]);
    const s = parse(r.compose).services.wiki!;
    expect(s.env_file).toEqual(["./.env"]);
    expect(s.volumes).toEqual(["./data:/data", "./wiki.conf:/etc/wiki.conf:ro", "./data/db:/db"]);
    expect(r.envText).toBe(dotenv);
    // Nothing the copy uses points back into the folder that "remove the old copy" deletes.
    expect(r.compose).not.toContain(casa);
    expect(r.stays).toEqual([]);
    expect(r.copies.map((c) => [c.from, c.to])).toEqual([
      [`${casa}/data`, "/srv/gluon-apps/wiki/data"],
      [`${casa}/wiki.conf`, "/srv/gluon-apps/wiki/wiki.conf"],
      ["/DATA/AppData/wiki/db", "/srv/gluon-apps/wiki/data/db"],
    ]);
  });

  it("reads short volume syntax with a default that has a colon in it", () => {
    const r = rewriteCompose({
      source: "compose",
      appId: "m",
      project: "m",
      newProject: "m",
      newDir: "/srv/gluon-apps/m",
      composeText: "services:\n  m:\n    image: m\n    volumes:\n      - ${MEDIA:-/mnt/media}:/media:ro\n",
      workingDir: "/home/luke/m",
      ownDirs: [{ path: "/home/luke/m", to: "" }],
      vars: {},
      runtime: [],
      volumes: [],
      appContainers: [],
      meta: { name: "m", icon: null, description: null, webPort: null, path: null },
    });
    expect(parse(r.compose).services.m!.volumes).toEqual(["/mnt/media:/media:ro"]);
    expect(r.stays).toEqual([{ path: "/mnt/media", services: ["m"], readOnly: true }]);
  });

  it("copies a compose folder's own files and private volumes, and shares the ones other apps use", () => {
    const vol = (name: string, usedBy: string[]): VolumeInfo => ({ name, mountpoint: `/var/lib/docker/volumes/${name}/_data`, driver: "local", hasOptions: false, usedBy });
    const dotenv = "CLOUDFLARE_API_TOKEN=REDACTED\n";
    const r = rewriteCompose({
      source: "compose",
      appId: "proxy",
      project: "proxy",
      newProject: "proxy-gluon",
      newDir: "/srv/gluon-apps/proxy-gluon",
      composeText: fixture("compose-proxy.yml"),
      workingDir: "/home/luke/proxy",
      ownDirs: [{ path: "/home/luke/proxy", to: "" }],
      vars: { CLOUDFLARE_API_TOKEN: "REDACTED" },
      dotenvText: dotenv,
      runtime: [],
      volumes: [vol("proxy_caddy_data", ["caddy"]), vol("proxy_caddy_config", ["caddy"]), vol("proxy_caddy_admin", ["caddy", "tend-dev"])],
      appContainers: ["caddy", "cloudflare-ddns"],
      meta: { name: "Proxy", icon: null, description: null, webPort: null, path: null },
    });
    expect(r.blockers).toEqual([]);
    const doc = parse(r.compose);
    const caddy = doc.services.caddy!;
    // The YAML anchors (<<: *hardening) are folded in.
    expect(caddy.read_only).toBe(true);
    expect(caddy.volumes).toEqual(["./caddy:/etc/caddy:ro", "caddy_admin:/run/caddy", "./volumes/caddy_data:/data", "./volumes/caddy_config:/config"]);
    expect(doc.volumes).toEqual({ caddy_admin: { external: true, name: "proxy_caddy_admin" } });
    expect(r.sharedVolumes).toEqual(["proxy_caddy_admin"]);
    expect(doc.networks).toEqual({ proxy: { external: true, name: "proxy" } });
    // Its old container name was its service name, which Compose already answers to.
    expect(caddy.networks).toEqual({ proxy: null });
    expect(doc.services.ddns!.env_file).toEqual(["./.env"]);
    expect(r.envText).toBe(dotenv);
    expect(r.copies.map((c) => c.from).sort()).toEqual(["/home/luke/proxy/caddy", "/var/lib/docker/volumes/proxy_caddy_config/_data", "/var/lib/docker/volumes/proxy_caddy_data/_data"]);
    expect(r.ports.map((p) => `${p.host}/${p.proto}`)).toEqual(["80/tcp", "443/tcp", "443/udp"]);
    expect(r.warnings.some((w) => w.includes("“proxy”"))).toBe(true);
  });

  it("uses a project folder in place, never copying it, when another container mounts it too", () => {
    const r = rewriteCompose({
      source: "compose",
      appId: "arr",
      project: "arr",
      newProject: "arr",
      newDir: "/srv/gluon-apps/arr",
      composeText: "services:\n  sonarr:\n    image: sonarr\n    volumes:\n      - ./downloads:/downloads\n      - ./config:/config\n",
      workingDir: "/opt/arr",
      ownDirs: [{ path: "/opt/arr", to: "" }],
      vars: {},
      runtime: [],
      volumes: [],
      appContainers: ["arr-sonarr-1"],
      binds: [
        { source: "/opt/arr/downloads", container: "arr-sonarr-1" },
        { source: "/opt/arr/downloads/movies", container: "radarr" },
        // Sees everything under /opt without using any one app's data (like Umbrel's /srv/umbrel).
        { source: "/opt", container: "backup" },
      ],
      meta: { name: "Arr", icon: null, description: null, webPort: null, path: null },
    });
    expect(parse(r.compose).services.sonarr!.volumes).toEqual(["/opt/arr/downloads:/downloads", "./config:/config"]);
    expect(r.copies.map((c) => c.from)).toEqual(["/opt/arr/config"]);
    expect(r.stays.map((x) => x.path)).toEqual(["/opt/arr/downloads"]);
    expect(r.warnings).toContain("/opt/arr/downloads is also used by radarr, so the copy uses it in place instead of copying it.");
  });

  it("keeps data an image's own VOLUME holds, even when the compose file never mentions it", () => {
    const r = rewriteCompose({
      source: "compose",
      appId: "db",
      project: "db",
      newProject: "db",
      newDir: "/srv/gluon-apps/db",
      composeText: "services:\n  pg:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${PG_PASS:-change-me}\n",
      workingDir: "/home/luke/db",
      ownDirs: [{ path: "/home/luke/db", to: "" }],
      vars: {},
      runtime: [{ service: "pg", container: "db-pg-1", env: [], mounts: [{ type: "volume", name: "f".repeat(64), source: `/var/lib/docker/volumes/${"f".repeat(64)}/_data`, destination: "/var/lib/postgresql/data", rw: true }] }],
      volumes: [],
      appContainers: ["db-pg-1"],
      meta: { name: "db", icon: null, description: null, webPort: null, path: null },
    });
    // A default covers the unset variable, so it isn't a blocker.
    expect(r.blockers).toEqual([]);
    expect(parse(r.compose).services.pg!.volumes).toEqual(["./volumes/pg-var-lib-postgresql-data:/var/lib/postgresql/data"]);
    expect(r.copies).toEqual([{ from: `/var/lib/docker/volumes/${"f".repeat(64)}/_data`, to: "/srv/gluon-apps/db/volumes/pg-var-lib-postgresql-data", kind: "volume", services: ["pg"], volume: "f".repeat(64) }]);
  });
});

describe("variables", () => {
  it("lines a template up with its value, backing off when the split is ambiguous", () => {
    expect(learnVars("${UMBREL_ROOT}/app-data/${APP}/data", "/srv/umbrel/app-data/immich/data")).toEqual({ UMBREL_ROOT: "/srv/umbrel", APP: "immich" });
    expect(learnVars("${A}/x/${A}", "/p/x//p")).toEqual({ A: "/p" });
    expect(learnVars("${A}/x/${A}", "/p/x/q")).toBeNull();
    expect(learnVars("${A}${B}", "abc")).toBeNull();
    expect(interpolate("$${KEEP} ${X:-def} ${Y-}${Z}", { Z: "z" })).toEqual({ value: "${KEEP} def z", missing: [] });
    expect(interpolate("${NOPE}/x", {}).missing).toEqual(["NOPE"]);
  });
});
