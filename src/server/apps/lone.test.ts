import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { composeFromContainer, type ContainerInspect, type ImageInspect } from "./lone";
import type { VolumeInfo } from "./rewrite";

const load = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", f), "utf8")) as { container: ContainerInspect; image: ImageInspect };
const meta = (name: string) => ({ name, icon: null, description: null, webPort: null, path: null });
const vol = (name: string, usedBy: string[]): VolumeInfo => ({ name, mountpoint: `/var/lib/docker/volumes/${name}/_data`, driver: "local", hasOptions: false, usedBy });
const service = (compose: string) => Object.values((YAML.parse(compose) as { services: Record<string, Record<string, unknown>> }).services)[0]!;

describe("composeFromContainer", () => {
  it("rebuilds a privileged host-network container, copying its own volumes and sharing the rest", () => {
    const { container, image } = load("lone-tend-dev.json");
    const r = composeFromContainer({
      container,
      image,
      newProject: "tend-dev",
      newDir: "/srv/gluon-apps/tend-dev",
      volumes: [vol("tend-dev-data", ["tend-dev"]), vol("tend-dev-next", ["tend-dev"]), vol("tend-dev-node-modules", ["tend-dev"]), vol("proxy_caddy_admin", ["tend-dev", "caddy"])],
      meta: meta("Tend dev"),
    });
    const doc = YAML.parse(r.compose) as { services: Record<string, Record<string, unknown>>; volumes: Record<string, unknown> };
    const s = doc.services["tend-dev"]!;
    // Only what the image doesn't already say.
    expect(s.environment).toEqual(["PORT=8131"]);
    expect(s.command).toBeUndefined();
    expect(s.entrypoint).toBeUndefined();
    expect(s.working_dir).toBeUndefined();
    expect(s).toMatchObject({ network_mode: "host", privileged: true, pid: "host", cgroup: "host", restart: "unless-stopped" });
    // Host networking: no ports, no hostname.
    expect(s.ports).toBeUndefined();
    expect(s.hostname).toBeUndefined();
    expect(s.volumes).toEqual([
      "/home/luke/tend:/app",
      "./volumes/tend-dev-data:/data",
      "/home/luke/proxy/caddy:/proxy-caddy",
      "./volumes/tend-dev-next:/app/.next",
      "./volumes/tend-dev-node-modules:/app/node_modules",
      "proxy_caddy_admin:/run/caddy",
      "/var/run/docker.sock:/var/run/docker.sock",
    ]);
    expect(doc.volumes).toEqual({ proxy_caddy_admin: { external: true, name: "proxy_caddy_admin" } });
    expect(r.copies.map((c) => c.volume)).toEqual(["tend-dev-data", "tend-dev-next", "tend-dev-node-modules"]);
    expect(r.stays.map((x) => x.path)).toEqual(["/home/luke/tend", "/home/luke/proxy/caddy", "/var/run/docker.sock"]);
    expect(r.warnings.some((w) => w.includes("caddy"))).toBe(true);
  });

  it("joins a container's own network, keeps its health check and warns when another tool manages it", () => {
    const { container, image } = load("lone-sentinel.json");
    const r = composeFromContainer({ container, image, newProject: "sentinel", newDir: "/srv/gluon-apps/sentinel", volumes: [], meta: meta("Sentinel") });
    const doc = YAML.parse(r.compose) as { networks: Record<string, unknown> };
    const s = service(r.compose);
    expect(doc.networks).toEqual({ coolify: { external: true } });
    // Service name and old container name match, so nothing extra is needed to keep its DNS name.
    expect(s.networks).toEqual({ coolify: null });
    expect(s.healthcheck).toEqual({ test: ["CMD-SHELL", "curl --fail http://127.0.0.1:8888/api/health || exit 1"], interval: "10s", timeout: "3s", start_period: "120s", retries: 3 });
    expect(s.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
    expect(s.security_opt).toEqual(["label=disable"]);
    expect(s.restart).toBeUndefined();
    // The image already sets coolify.managed, so it isn't repeated, but Coolify still gets a warning.
    expect(s.labels).toBeUndefined();
    expect(r.warnings.some((w) => w.startsWith("Coolify manages"))).toBe(true);
    expect(r.copies).toEqual([]);
  });

  it("escapes dollar signs, keeps published addresses and copies anonymous volumes", () => {
    const anon = "a".repeat(64);
    const container: ContainerInspect = {
      Id: "0123456789abcdef",
      Name: "/My.Wiki",
      Config: { Image: "wiki:2", Env: ["PATH=/bin", "SECRET=pa$$word", "GREETING=hi $USER"], Cmd: ["serve", "--port=${PORT}"], Hostname: "wiki-host", Labels: { "com.docker.compose.oneoff": "False", team: "home" } },
      HostConfig: {
        NetworkMode: "bridge",
        PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }], "53/udp": [{ HostIp: "", HostPort: "5353" }], "9000/tcp": [{ HostIp: "", HostPort: "" }] },
        RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
        Devices: [{ PathOnHost: "/dev/dri", PathInContainer: "/dev/dri", CgroupPermissions: "rwm" }],
      },
      Mounts: [{ Type: "volume", Name: anon, Source: `/var/lib/docker/volumes/${anon}/_data`, Destination: "/var/lib/wiki", RW: true }],
    };
    const r = composeFromContainer({ container, image: { Config: { Env: ["PATH=/bin"], Cmd: ["serve"] } }, newProject: "my-wiki", newDir: "/srv/gluon-apps/my-wiki", volumes: [], meta: meta("My Wiki") });
    const s = service(r.compose);
    expect(s.environment).toEqual(["SECRET=pa$$$$word", "GREETING=hi $$USER"]);
    expect(s.command).toEqual(["serve", "--port=$${PORT}"]);
    expect(s.ports).toEqual(["127.0.0.1:8080:80", "5353:53/udp", "9000"]);
    expect(s).toMatchObject({ network_mode: "bridge", hostname: "wiki-host", restart: "on-failure:5", devices: ["/dev/dri:/dev/dri"], labels: { team: "home" } });
    expect(s.volumes).toEqual(["./volumes/my-wiki-var-lib-wiki:/var/lib/wiki"]);
    expect(r.copies).toEqual([{ from: `/var/lib/docker/volumes/${anon}/_data`, to: "/srv/gluon-apps/my-wiki/volumes/my-wiki-var-lib-wiki", kind: "volume", services: ["my-wiki"], volume: anon }]);
    expect(r.ports.map((p) => `${p.host}/${p.proto}`)).toEqual(["8080/tcp", "5353/udp"]);
  });
});
