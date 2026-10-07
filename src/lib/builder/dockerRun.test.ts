import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { composeFromDockerRun, draftFromDockerRun, parseDockerRun, splitCommand } from "./dockerRun";
import { choosePendingFolder, parseCompose, readService, stringify } from "./compose";
import { analyze } from "./analyze";

/** The compose service a command becomes, as plain data. */
function service(cmd: string) {
  const r = composeFromDockerRun(cmd);
  expect(r.error).toBeNull();
  const js = parseDocument(r.compose).toJS() as { services: Record<string, Record<string, unknown>>; networks?: Record<string, unknown> };
  return { r, svc: js.services[r.service]!, top: js };
}

const form = (cmd: string) => {
  const r = composeFromDockerRun(cmd);
  const p = parseCompose(r.compose);
  return readService(p.doc, r.service);
};

// From linuxserver/docker-jellyfin's README, as people copy it.
const JELLYFIN = `docker run -d \\
  --name=jellyfin \\
  -e PUID=1000 \\
  -e PGID=1000 \\
  -e TZ=Etc/UTC \\
  -e JELLYFIN_PublishedServerUrl=http://192.168.0.5 \`#optional\` \\
  -p 8096:8096 \\
  -p 8920:8920 \`#optional\` \\
  -p 7359:7359/udp \`#optional\` \\
  -p 1900:1900/udp \`#optional\` \\
  -v /path/to/jellyfin/library:/config \\
  -v /path/to/tvseries:/data/tvshows \\
  -v /path/to/movies:/data/movies \\
  --restart unless-stopped \\
  lscr.io/linuxserver/jellyfin:latest`;

describe("LinuxServer README commands", () => {
  it("turns the Jellyfin command into one service with every setting", () => {
    const f = form(JELLYFIN);
    expect(f.name).toBe("jellyfin");
    expect(f.image).toBe("lscr.io/linuxserver/jellyfin:latest");
    expect(f.restart).toBe("unless-stopped");
    expect(f.env.map((e) => [e.key, e.value])).toEqual([
      ["PUID", "1000"],
      ["PGID", "1000"],
      ["TZ", "Etc/UTC"],
      ["JELLYFIN_PublishedServerUrl", "http://192.168.0.5"],
    ]);
    expect(f.ports.map((p) => [p.host, p.container, p.proto])).toEqual([
      [8096, 8096, "tcp"],
      [8920, 8920, "tcp"],
      [7359, 7359, "udp"],
      [1900, 1900, "udp"],
    ]);
  });

  it("keeps the /path/to config placeholder in app data, and leaves the media libraries for the person to choose", () => {
    const { r, svc } = service(JELLYFIN);
    const f = form(JELLYFIN);
    expect(f.volumes.map((v) => [v.kind, v.source, v.target])).toEqual([["data", "jellyfin-library", "/config"]]);
    expect(f.pendingFolders).toEqual(["/data/tvshows", "/data/movies"]);
    // Nothing empty is mounted while they wait.
    expect(svc.volumes).toEqual(["${APP_DATA_DIR}/data/jellyfin-library:/config"]);
    expect(r.notes.find((n) => n.text.includes("placeholder"))!.text).toContain("data/jellyfin-library");
    expect(r.notes.some((n) => n.text.startsWith("/data/tvshows, /data/movies hold your TV and movies"))).toBe(true);
    expect(r.unknown).toEqual([]);
  });

  it("names the app after --name", () => {
    expect(composeFromDockerRun(JELLYFIN).name).toBe("Jellyfin");
  });

  it("can't start until the media folders are chosen, and then has no errors", () => {
    const { prepared } = draftFromDockerRun(JELLYFIN, "compose");
    expect(prepared).not.toBeNull();
    const ctx = { source: "compose" as const, target: "compose" as const, web: prepared!.web, secrets: prepared!.secrets };
    const errors = analyze(prepared!.text, ctx).issues.filter((i) => i.level === "error");
    expect(errors.map((i) => i.message)).toEqual(["Choose a folder for /data/tvshows.", "Choose a folder for /data/movies."]);
    const p = parseCompose(prepared!.text);
    choosePendingFolder(p.doc, "jellyfin", "/data/tvshows", "/srv/media/tv");
    choosePendingFolder(p.doc, "jellyfin", "/data/movies", "/srv/media/movies");
    const chosen = stringify(p.doc);
    expect(analyze(chosen, ctx).issues.filter((i) => i.level === "error")).toEqual([]);
    expect(readService(parseCompose(chosen).doc, "jellyfin").volumes.map((v) => `${v.source}:${v.target}`)).toEqual(["jellyfin-library:/config", "/srv/media/tv:/data/tvshows", "/srv/media/movies:/data/movies"]);
    expect(chosen).not.toContain("x-gluon-choose-folder");
    expect(prepared!.web).toMatchObject({ service: "jellyfin", containerPort: 8096, port: 8096 });
  });

  it("reads a command copied with Windows line endings and spaces after the backslashes", () => {
    const f = form("docker run -d \\  \r\n  --name=sonarr \\ \r\n  -p 8989:8989 \\\r\n  -v /srv/tv:/tv \\\r\n  lscr.io/linuxserver/sonarr:latest\r\n");
    expect(f.image).toBe("lscr.io/linuxserver/sonarr:latest");
    expect(f.ports[0]).toMatchObject({ host: 8989, container: 8989 });
    expect(f.volumes[0]).toMatchObject({ kind: "host", source: "/srv/tv", target: "/tv" });
  });
});

describe("shell words", () => {
  it("keeps quoted spaces, escaped quotes and && inside quotes in one word", () => {
    const { commands } = splitCommand(`docker run -e "GREETING=hello world" -e MSG=a\\ b -e Q="say \\"hi\\"" alpine sh -c 'echo hi && sleep 1'`);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(["docker", "run", "-e", "GREETING=hello world", "-e", "MSG=a b", "-e", 'Q=say "hi"', "alpine", "sh", "-c", "echo hi && sleep 1"]);
  });

  it("joins PowerShell backtick and cmd caret continuations", () => {
    expect(form("docker run -d `\n  -p 3000:3000 `\n  ghcr.io/open-webui/open-webui:main").ports[0]).toMatchObject({ host: 3000, container: 3000 });
    expect(form("docker run -d ^\n  -p 9000:9000 ^\n  portainer/portainer-ce").image).toBe("portainer/portainer-ce");
  });

  it("drops shell comments and prompt characters", () => {
    const f = form("$ docker run -d \\\n  # the web page\n  -p 80:80 \\\n  nginx");
    expect(f.image).toBe("nginx");
    expect(f.ports).toHaveLength(1);
    const g = form("$ docker run -d -p 80:80 nginx # serves the site");
    expect(g.image).toBe("nginx");
    expect(g.ports).toHaveLength(1);
  });
});

describe("values compose would read differently", () => {
  it("keeps $ from single quotes literal ($$) and leaves shell variables for compose to fill", () => {
    const { r } = service(`docker run -e 'PRICE=$5' -e "HOME_DIR=$HOME" nginx`);
    expect(r.compose).toContain("PRICE: $$5");
    const f = form(`docker run -e 'PRICE=$5' -e "HOME_DIR=$HOME" nginx`);
    expect(f.env.find((e) => e.key === "PRICE")).toMatchObject({ value: "$5", interpolated: false });
    expect(f.env.find((e) => e.key === "HOME_DIR")).toMatchObject({ value: "$HOME", interpolated: true });
  });

  it("quotes ports and numbers-as-strings so YAML 1.1 readers don't turn them into numbers", () => {
    const { r } = service("docker run -p 22:22 -e ENABLED=true -e PUID=1000 gitea/gitea");
    expect(r.compose).toContain('"22:22"');
    expect(r.compose).toContain('ENABLED: "true"');
    expect(r.compose).toContain('PUID: "1000"');
  });

  it("asks for values -e takes from the shell", () => {
    const { r, svc } = service("docker run -e TZ -e OPENAI_API_KEY= nginx");
    expect(svc.environment).toEqual({ TZ: "", OPENAI_API_KEY: "" });
    expect(r.notes.some((n) => n.text.includes("Enter the value for TZ"))).toBe(true);
  });
});

describe("flag forms", () => {
  it("reads bundled short flags with an attached value", () => {
    const { svc } = service("docker run -dit -p8080:80 -eFOO=bar -v/srv/www:/usr/share/nginx/html:ro nginx");
    expect(svc.ports).toEqual(["8080:80"]);
    expect(svc.environment).toEqual({ FOO: "bar" });
    expect(svc.volumes).toEqual(["/srv/www:/usr/share/nginx/html:ro"]);
    expect(svc).toMatchObject({ tty: true, stdin_open: true });
  });

  it("reads --flag=value and treats --network=host as the server's network", () => {
    const { r, svc } = service("docker run --name=ha --restart=always --network=host -p 8123:8123 --privileged ghcr.io/home-assistant/home-assistant:stable");
    expect(svc).toMatchObject({ restart: "always", network_mode: "host", privileged: true });
    expect(svc.ports).toBeUndefined();
    expect(r.notes.some((n) => n.text.includes("-p mappings aren't needed"))).toBe(true);
    expect(r.service).toBe("ha");
  });

  it("joins existing networks next to the app's own", () => {
    const { svc, top } = service("docker run --network proxy --name whoami traefik/whoami");
    expect(svc.networks).toEqual(["default", "proxy"]);
    expect(top.networks).toEqual({ proxy: { external: true } });
    const f = form("docker run --network proxy traefik/whoami");
    expect(f.networks).toEqual(["default", "proxy"]);
  });

  it("restarts unless stopped when docker run didn't say, and says so", () => {
    const { r, svc } = service("docker run -d nginx");
    expect(svc.restart).toBe("unless-stopped");
    expect(r.notes.some((n) => n.text.startsWith("It restarts unless you stop it"))).toBe(true);
  });

  it("refuses a restart policy Docker doesn't have", () => {
    const { r, svc } = service("docker run --restart sometimes nginx");
    expect(svc.restart).toBe("unless-stopped");
    expect(r.notes.some((n) => n.flag === "--restart")).toBe(true);
  });

  it("keeps the trailing command as an exec list and --entrypoint as one program", () => {
    const { r, svc } = service(`docker run --rm --entrypoint /bin/sh -w /app -u 1000:1000 alpine:3.20 -c 'echo hi && sleep 1'`);
    expect(svc).toMatchObject({ entrypoint: ["/bin/sh"], working_dir: "/app", user: "1000:1000", command: ["-c", "echo hi && sleep 1"] });
    expect(r.notes.some((n) => n.flag === "--rm")).toBe(true);
  });
});

describe("GPUs and resources", () => {
  it.each([
    ["all", { driver: "nvidia", count: "all", capabilities: ["gpu"] }],
    ["2", { driver: "nvidia", count: 2, capabilities: ["gpu"] }],
    [`'"device=0,2"'`, { driver: "nvidia", device_ids: ["0", "2"], capabilities: ["gpu"] }],
    [`'"device=1","capabilities=compute,utility"'`, { driver: "nvidia", device_ids: ["1"], capabilities: ["compute", "utility"] }],
  ])("--gpus %s reserves the right devices", (arg, device) => {
    const { svc } = service(`docker run --gpus ${arg} ollama/ollama`);
    expect(svc.deploy).toEqual({ resources: { reservations: { devices: [device] } } });
  });

  it("shows --gpus all as the form's GPU switch, without listing deploy as extra", () => {
    const f = form("docker run --gpus all -m 4G --cpus 2.5 ollama/ollama");
    expect(f).toMatchObject({ gpu: true, memory: "4g", cpus: "2.5" });
    expect(f.extraKeys).not.toContain("deploy");
  });

  it("maps capabilities, devices, sysctls, ulimits, hosts and health checks", () => {
    const { svc } = service(
      "docker run --cap-add=NET_ADMIN --cap-add SYS_MODULE --device /dev/net/tun --sysctl net.ipv4.conf.all.src_valid_mark=1 " +
        "--ulimit nofile=65535:65535 --add-host host.docker.internal:host-gateway --shm-size 1g --hostname vpn " +
        "--health-cmd 'curl -fs http://localhost:8000 || exit 1' --health-interval 30s --health-retries 3 --health-start-period 1m " +
        "-l traefik.enable=true --label com.example.role=vpn qmcgaw/gluetun",
    );
    expect(svc).toMatchObject({
      cap_add: ["NET_ADMIN", "SYS_MODULE"],
      devices: ["/dev/net/tun"],
      sysctls: { "net.ipv4.conf.all.src_valid_mark": "1" },
      ulimits: { nofile: { soft: 65535, hard: 65535 } },
      extra_hosts: ["host.docker.internal:host-gateway"],
      shm_size: "1g",
      hostname: "vpn",
      labels: { "traefik.enable": "true", "com.example.role": "vpn" },
      healthcheck: { test: ["CMD-SHELL", "curl -fs http://localhost:8000 || exit 1"], interval: "30s", retries: 3, start_period: "1m" },
    });
  });
});

describe("folders", () => {
  it("keeps relative, $(pwd), named and anonymous volumes in the app's data folder, but never a media library", () => {
    const f = form("docker run -v ./data:/data -v $(pwd)/config:/config -v ~/media:/media -v pgdata:/var/lib/postgresql/data -v /cache -v /music postgres:16");
    expect(f.volumes.map((v) => [v.kind, v.source, v.target])).toEqual([
      ["data", "data", "/data"],
      ["data", "config", "/config"],
      ["data", "pgdata", "/var/lib/postgresql/data"],
      ["data", "cache", "/cache"],
    ]);
    expect(f.pendingFolders).toEqual(["/media", "/music"]);
  });

  it("keeps a media folder the command names exactly", () => {
    const f = form("docker run -v /srv/music:/music:ro deluan/navidrome");
    expect(f.volumes.map((v) => [v.kind, v.source, v.target, v.readOnly])).toEqual([["host", "/srv/music", "/music", true]]);
    expect(f.pendingFolders).toEqual([]);
  });

  it("reads --mount binds, volumes and tmpfs", () => {
    const { svc } = service("docker run --mount type=bind,source=/srv/media,target=/media,readonly --mount type=volume,src=pgdata,dst=/var/lib/postgresql/data --mount type=tmpfs,target=/cache,tmpfs-size=64m postgres");
    expect(svc.volumes).toEqual(["/srv/media:/media:ro", "${APP_DATA_DIR}/data/pgdata:/var/lib/postgresql/data"]);
    expect(svc.tmpfs).toEqual(["/cache:size=64m"]);
  });
});

describe("what can't carry over is reported, never dropped silently", () => {
  it("notes --env-file and --volumes-from as unsupported", () => {
    const r = parseDockerRun("docker run --env-file .env --volumes-from data nginx");
    expect(r.ok).toBe(true);
    expect(r.notes.filter((n) => n.level === "warning").map((n) => n.flag)).toEqual(["--env-file", "--volumes-from"]);
  });

  it("lists unknown flags and still finds the image", () => {
    const r = parseDockerRun("docker run --frobnicate yes -Z --quux=1 -p 80:80 nginx");
    expect(r.image).toBe("nginx");
    expect(r.unknown).toEqual(["--frobnicate yes", "-Z", "--quux=1"]);
    expect(r.notes.some((n) => n.text.includes("--frobnicate yes, -Z, --quux=1"))).toBe(true);
  });

  it("doesn't let an unknown flag swallow the image", () => {
    const r = parseDockerRun("docker run --some-new-flag nginx");
    expect(r.image).toBe("nginx");
    expect(r.unknown).toEqual(["--some-new-flag"]);
  });
});

describe("finding the docker run", () => {
  it("skips sudo, global flags and the commands around it", () => {
    const r = parseDockerRun("sudo -E docker --context home container run -d --name web nginx:1.27 && docker logs -f web");
    expect(r).toMatchObject({ ok: true, image: "nginx:1.27", service: "web" });
    expect(r.notes.some((n) => n.text.startsWith("Only the docker run command"))).toBe(true);
    expect(parseDockerRun("docker pull nginx; docker run -d nginx").image).toBe("nginx");
  });

  it("reads podman and nerdctl", () => {
    expect(parseDockerRun("podman run -d docker.io/library/redis:7").image).toBe("docker.io/library/redis:7");
    expect(parseDockerRun("nerdctl run -d redis").image).toBe("redis");
  });

  it.each([
    ["", "Paste a docker run command."],
    ["docker ps -a", "Paste a command that starts with docker run."],
    ["docker compose up -d", "That's a docker compose command."],
    ["docker run -d --name web", "The command has no image."],
    ["docker run -p", "-p needs a value"],
    ["docker run -d Nginx", "doesn't look like an image"],
  ])("explains what's wrong with %j", (cmd, message) => {
    const r = parseDockerRun(cmd);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });
});

describe("secrets", () => {
  it("keeps secret-looking values out of the compose file", () => {
    const { prepared } = draftFromDockerRun("docker run -e POSTGRES_PASSWORD=hunter2 -e POSTGRES_USER=app -v pg:/var/lib/postgresql/data postgres:16", "compose");
    expect(prepared!.text).not.toContain("hunter2");
    expect(prepared!.secretValues).toEqual({ postgres: { POSTGRES_PASSWORD: "hunter2" } });
    expect(prepared!.text).toContain("POSTGRES_USER: app");
  });
});
