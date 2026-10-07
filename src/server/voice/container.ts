import "server-only";
import { docker } from "../docker/client";
import { getApp, type AppSummary } from "../docker/apps";
import { execInContainer } from "../dockerx/containers";
import { notFound, AppError } from "../errors";
import { serviceKind } from "@/lib/service-kind";
import { envFor, envMap } from "./settings-map";
import { ICE_CONTAINER_PORT } from "./compose-edit";
import type { VoicePort } from "./types";
import { countEstablished } from "./proc-net";

/** What Docker says about an app's Mumble container: where Ice and the voice port are published, its settings. */

export interface MumbleFacts {
  app: AppSummary;
  id: string;
  name: string;
  service: string | null;
  image: string;
  version: string | null;
  running: boolean;
  startedAt: number | null;
  env: Record<string, string>;
  hostNetwork: boolean;
  ports: VoicePort[];
  /** The port Mumble listens on inside the container, and where that's published on the server. */
  voicePort: number;
  voiceHostPort: number | null;
  /** Where Gluon reaches Ice: a published 127.0.0.1 port, or the port itself on the host's network. */
  icePort: number | null;
  /** Ice is published, but on more than this server's loopback (anyone on the network could try it). */
  iceExposed: boolean;
  mounts: { source: string; destination: string; rw: boolean; type: string }[];
}

const isMumble = (image: string) => serviceKind([image]) === "mumble";

export async function mumbleApp(appId: string): Promise<AppSummary> {
  const app = await getApp(appId);
  if (!app) throw notFound("That app");
  if (app.self || !app.containers.some((c) => isMumble(c.image))) throw new AppError("not_mumble", `${app.name} doesn't run a Mumble server.`, 400);
  return app;
}

export async function mumbleFacts(appId: string): Promise<MumbleFacts> {
  const app = await mumbleApp(appId);
  const c = app.containers.find((x) => isMumble(x.image) && x.state === "running") ?? app.containers.find((x) => isMumble(x.image))!;
  const info = await docker().getContainer(c.id).inspect();
  const env = envMap(info.Config.Env);
  const hostNetwork = info.HostConfig.NetworkMode === "host";
  const ports: VoicePort[] = [];
  const bindings = (info.NetworkSettings.Ports ?? info.HostConfig.PortBindings ?? {}) as Record<string, { HostIp: string; HostPort: string }[] | null>;
  for (const [key, list] of Object.entries(bindings)) {
    const [port, proto] = key.split("/");
    for (const b of list ?? []) {
      const host = Number(b.HostPort);
      if (host) ports.push({ host, container: Number(port), proto: proto === "udp" ? "udp" : "tcp", ip: b.HostIp || "0.0.0.0" });
    }
  }
  const voicePort = Number(envFor("port", env)?.value) || 64738;
  const iceEnv = envFor("ice", env)?.value ?? "";
  const iceInner = Number(/-p\s+(\d+)/.exec(iceEnv)?.[1]) || ICE_CONTAINER_PORT;
  let icePort: number | null = null;
  let iceExposed = false;
  if (hostNetwork) {
    // Ice listens on the server itself; only use it when it's bound to loopback.
    if (/-h\s+(127\.0\.0\.1|localhost)/.test(iceEnv)) icePort = iceInner;
  } else {
    // Docker lists one binding per address family (0.0.0.0 and ::); the IPv4 loopback one is what Gluon uses.
    const binds = ports.filter((p) => p.container === iceInner && p.proto === "tcp");
    icePort = binds.find((p) => p.ip === "127.0.0.1")?.host ?? null;
    iceExposed = binds.some((p) => p.ip !== "127.0.0.1" && p.ip !== "::1");
    if (iceExposed && icePort === null) icePort = binds[0]?.host ?? null;
  }
  const label = info.Config.Labels?.["org.opencontainers.image.version"] ?? null;
  return {
    app,
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    service: c.service,
    image: info.Config.Image,
    version: label ? label.replace(/^v/, "") : (/:v?(\d+\.\d+(\.\d+)?)/.exec(info.Config.Image)?.[1] ?? null),
    running: !!info.State.Running,
    startedAt: info.State.Running && info.State.StartedAt ? Date.parse(info.State.StartedAt) : null,
    env,
    hostNetwork,
    ports: ports.filter((p, i, all) => all.findIndex((q) => q.host === p.host && q.container === p.container && q.proto === p.proto) === i),
    voicePort,
    voiceHostPort: hostNetwork ? voicePort : (ports.find((p) => p.container === voicePort && p.proto === "tcp")?.host ?? null),
    icePort,
    iceExposed,
    mounts: (info.Mounts ?? []).map((m) => ({ source: m.Source, destination: m.Destination, rw: m.RW, type: m.Type })),
  };
}

/**
 * How many people are connected, without Ice: established TCP connections to Mumble's port,
 * read from the container's own network table. Null when it can't be read.
 */
export async function countConnections(f: Pick<MumbleFacts, "id" | "name" | "voicePort" | "running">): Promise<number | null> {
  if (!f.running) return 0;
  let out = "";
  try {
    const r = await execInContainer(
      { id: f.id, name: f.name, argv: ["cat", "/proc/net/tcp", "/proc/net/tcp6"], user: undefined, workdir: undefined, timeoutSec: 5 },
      (e) => {
        if (e.type === "out") out += e.text;
      },
      AbortSignal.timeout(8000),
    );
    if (r.exitCode !== 0 && !out) return null;
  } catch {
    return null;
  }
  return countEstablished(out, f.voicePort);
}
