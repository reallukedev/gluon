import { describe, expect, it } from "vitest";
import type { ImageLookup } from "@/lib/builder-types";
import { draftFromImage, prepareCompose } from "./start";
import { parseCompose, readService } from "./compose";
import { analyze, applyAllFixes, applyFix } from "./analyze";
import { dataFolderFor, mediaKind } from "./names";

const lookup = (over: Partial<ImageLookup>): ImageLookup => ({ ref: "x", exists: true, local: false, unknownReason: null, tags: [], ports: [], volumes: [], env: [], user: null, description: null, ...over });
const svc = (text: string, name: string) => readService(parseCompose(text).doc, name);

describe("an app from an image", () => {
  // What the registry says about vaultwarden/server (ports, volume and env trimmed by hints()).
  const vaultwarden = lookup({
    ports: [{ port: 80, proto: "tcp" }, { port: 3012, proto: "tcp" }],
    volumes: ["/data"],
    env: [{ key: "ROCKET_PROFILE", value: "release" }, { key: "ROCKET_ADDRESS", value: "0.0.0.0" }, { key: "ADMIN_TOKEN", value: "" }, { key: "SMTP_PASSWORD", value: "default-pass" }],
    description: "Unofficial Bitwarden compatible server written in Rust. Formerly known as bitwarden_rs.",
  });

  it("serves the web page on its most likely port and publishes the others", () => {
    const d = draftFromImage("vaultwarden/server:1.32.0", vaultwarden);
    expect(d.spec.web).toMatchObject({ service: "server", containerPort: 80, port: 80 });
    expect(svc(d.spec.compose, "server").ports.map((p) => p.container)).toEqual([3012]);
    expect(d.spec.details).toMatchObject({ name: "Vaultwarden", version: "1.32.0", tagline: "Unofficial Bitwarden compatible server written in Rust." });
  });

  it("fills in the image's own settings and lifts secret-looking defaults into secrets", () => {
    const d = draftFromImage("vaultwarden/server", vaultwarden, "Vaultwarden");
    expect(svc(d.spec.compose, "server").env.map((e) => e.key)).toEqual(["ROCKET_PROFILE", "ROCKET_ADDRESS"]);
    // An empty secret default means the image doesn't need it; a set one is kept, encrypted.
    expect(d.secretValues).toEqual({ server: { SMTP_PASSWORD: "default-pass" } });
    expect(d.spec.compose).not.toContain("default-pass");
    expect(d.spec.details.name).toBe("Vaultwarden");
  });

  it("gives LinuxServer images PUID, PGID and TZ without duplicating ones the image sets", () => {
    const d = draftFromImage("lscr.io/linuxserver/sonarr:latest", lookup({ env: [{ key: "TZ", value: "Etc/UTC" }, { key: "PUID", value: "911" }], volumes: ["/config", "/tv", "/downloads"] }));
    const f = svc(d.spec.compose, "sonarr");
    expect(f.env.filter((e) => e.key === "TZ")).toHaveLength(1);
    expect(f.env.find((e) => e.key === "PUID")!.value).toBe("1000");
    expect(f.volumes.map((v) => v.source)).toEqual(["config"]);
    // Libraries and downloads live on the server's own disks, not in app data that goes with the app.
    expect(f.pendingFolders).toEqual(["/tv", "/downloads"]);
    expect(d.said.some((x) => x.startsWith("Choose where your TV and downloads are next"))).toBe(true);
  });

  it("works without a lookup (the registry couldn't be reached)", () => {
    const d = draftFromImage("ghcr.io/owner/tool:2", null);
    expect(svc(d.spec.compose, "tool").image).toBe("ghcr.io/owner/tool:2");
    expect(d.spec.web.service).toBeNull();
    expect(d.spec.details.website).toBe("https://github.com/owner/tool");
  });
});

describe("media libraries", () => {
  it.each([
    "/music", "/movies", "/tv", "/shows", "/media", "/photos", "/pictures", "/books", "/audiobooks", "/podcasts", "/comics", "/downloads",
    "/data/tvshows", "/data/movies", "/mnt/Music/", "/tv-shows", "/ebooks", "/manga", "/films", "/videos",
  ])("%s is a media library", (p) => {
    expect(mediaKind(p)).not.toBeNull();
  });

  it.each(["/config", "/data", "/app/data", "/var/lib/mysql", "/cache", "/library", "/images", "/musicbrainz", "/downloads-config", "/srv/media/config"])("%s isn't", (p) => {
    expect(mediaKind(p)).toBeNull();
  });

  it("names what it holds for the prompt", () => {
    expect([mediaKind("/data/tvshows"), mediaKind("/audiobooks"), mediaKind("/pictures")]).toEqual(["TV", "audiobooks", "photos"]);
  });

  it("asks for a server folder instead of moving a pasted media volume into app data", () => {
    const text = "services:\n  navidrome:\n    image: deluan/navidrome\n    volumes:\n      - ./data:/data\n      - ./music:/music:ro\n";
    const p = prepareCompose(text, "compose", "compose");
    const f = svc(p.text, "navidrome");
    expect(f.volumes.map((v) => [v.kind, v.source, v.target])).toEqual([["data", "data", "/data"]]);
    expect(f.pendingFolders).toEqual(["/music"]);
    expect(p.said.some((x) => x.startsWith("Choose a server folder for /music"))).toBe(true);
  });
});

describe("folder names", () => {
  it("names folders after the path without system noise, and never twice", () => {
    const taken = new Set<string>();
    expect(["/config", "/var/lib/mysql", "/data/tvshows", "/usr/share/nginx/html", "/config"].map((p) => dataFolderFor(p, taken))).toEqual(["config", "mysql", "data-tvshows", "nginx-html", "config-2"]);
  });
});

describe("a pasted compose file, made ready", () => {
  const PAPERLESS = `version: "3.4"
services:
  broker:
    image: docker.io/library/redis:7
    restart: unless-stopped
    volumes:
      - redisdata:/data
  webserver:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    restart: unless-stopped
    depends_on: [broker]
    ports:
      - "8000:8000"
    volumes:
      - data:/usr/src/paperless/data
      - ./consume:/usr/src/paperless/consume
    env_file: docker-compose.env
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_SECRET_KEY: change-me
volumes:
  data:
  redisdata:
`;

  it("applies every fix, finds the web page and lifts secrets", () => {
    const p = prepareCompose(PAPERLESS, "compose", "compose");
    expect(p.web).toMatchObject({ service: "webserver", containerPort: 8000, port: 8000 });
    expect(p.secretValues).toEqual({ webserver: { PAPERLESS_SECRET_KEY: "change-me" } });
    const web = svc(p.text, "webserver");
    expect(web.volumes.map((v) => [v.kind, v.source])).toEqual([
      ["data", "data"],
      ["data", "consume"],
    ]);
    expect(p.text).not.toMatch(/^version:/m);
    expect(p.text).not.toMatch(/^volumes:/m);
    expect(p.text).not.toContain("env_file");
    const errors = analyze(p.text, { source: "compose", target: "compose", web: p.web, secrets: p.secrets }).issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("removes the web port Umbrel's proxy needs when the app installs through Umbrel", () => {
    const p = prepareCompose(PAPERLESS, "umbrel", "compose");
    expect(svc(p.text, "webserver").ports).toEqual([]);
    expect(p.said.some((s) => s.includes("Umbrel's proxy now serves port 8000"))).toBe(true);
  });
});

describe("one-click fixes", () => {
  const ctx = { source: "compose" as const, target: "compose" as const, web: { service: null, containerPort: null, port: null, path: "", umbrelAuth: true }, secrets: {} };

  it("turns a variable nothing sets into a secret to fill in", () => {
    const text = "services:\n  db:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASS}\n";
    const issue = analyze(text, ctx).issues.find((i) => i.id.startsWith("env-ref"))!;
    expect(issue.fix!.label).toBe("Enter it as a secret");
    const r = applyFix(text, issue.fix!.id, ctx)!;
    expect(r.secrets).toEqual({ db: ["POSTGRES_PASSWORD"] });
    expect(svc(r.text, "db").env).toEqual([]);
  });

  it("declares a network a service joins but the file doesn't declare", () => {
    const text = "services:\n  app:\n    image: x\n    networks: [default, proxy]\n";
    const issue = analyze(text, ctx).issues.find((i) => i.id === "net-undeclared-app-proxy")!;
    expect(issue.level).toBe("error");
    const r = applyFix(text, issue.fix!.id, ctx)!;
    expect(analyze(r.text, ctx).issues.filter((i) => i.level === "error")).toEqual([]);
    // Fixing twice is a no-op, so a stale button can't break the file.
    expect(applyFix(r.text, issue.fix!.id, ctx)).toBeNull();
  });

  it("leaves fixed container names alone in Fix all", () => {
    const text = "services:\n  app:\n    image: x\n    container_name: app\n";
    expect(applyAllFixes(text, ctx).text).toContain("container_name: app");
  });

  it("flags health check timings and CPU limits compose would refuse", () => {
    const text = "services:\n  app:\n    image: x\n    cpus: lots\n    healthcheck:\n      test: [CMD, true]\n      interval: '30'\n      retries: many\n";
    const ids = analyze(text, ctx).issues.filter((i) => i.level === "error").map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["cpus-app", "health-interval-app", "health-retries-app"]));
  });
});
