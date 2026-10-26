import "server-only";
import path from "node:path";
import { Collector, anonFolder, dedupePorts, gluonMeta, publishedPorts, render, type AppMeta, type Rewritten, type VolumeInfo } from "./rewrite";
import { escapeDollars } from "./vars";
import { norm, slugify } from "./paths";

/** The parts of `docker inspect <container>` a compose service is made from. */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    User?: string;
    Labels?: Record<string, string> | null;
    Hostname?: string;
    Healthcheck?: Healthcheck | null;
    StopSignal?: string;
  };
  HostConfig: {
    NetworkMode?: string;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    Devices?: { PathOnHost: string; PathInContainer: string; CgroupPermissions?: string }[] | null;
    Privileged?: boolean;
    PidMode?: string;
    IpcMode?: string;
    CgroupnsMode?: string;
    ExtraHosts?: string[] | null;
    Tmpfs?: Record<string, string> | null;
    ShmSize?: number;
    SecurityOpt?: string[] | null;
    Init?: boolean | null;
    Dns?: string[] | null;
    GroupAdd?: string[] | null;
    Sysctls?: Record<string, string> | null;
    Memory?: number;
    NanoCpus?: number;
  };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean; Mode?: string; Driver?: string }[];
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

interface Healthcheck {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  StartPeriod?: number;
  Retries?: number;
}

/** The parts of `docker image inspect` that say what the image does on its own. */
export interface ImageInspect {
  Config?: {
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string | null;
    User?: string | null;
    Labels?: Record<string, string> | null;
    Healthcheck?: Healthcheck | null;
  } | null;
}

export interface LoneInput {
  container: ContainerInspect;
  image: ImageInspect | null;
  newProject: string;
  newDir: string;
  volumes: VolumeInfo[];
  meta: AppMeta;
}

const ANON = /^[0-9a-f]{64}$/;
const DEFAULT_SHM = 64 * 1024 * 1024;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const list = (a: string[] | null | undefined) => (a?.length ? a : null);

function duration(ns: number | undefined): string | undefined {
  if (!ns) return undefined;
  const s = ns / 1e9;
  return Number.isInteger(s) ? `${s}s` : `${Math.round(ns / 1e6)}ms`;
}

const managers: [RegExp, string][] = [
  [/^coolify\./, "Coolify"],
  [/^io\.portainer\./, "Portainer"],
  [/^dev\.dokploy\./, "Dokploy"],
  [/^caprover\./, "CapRover"],
];

/**
 * A compose service that recreates a container started with `docker run`. Only what differs from
 * the image goes in (env the image doesn't set, a command that isn't the image's own), so the file
 * reads like one a person would write.
 */
export function composeFromContainer(input: LoneInput): Rewritten {
  const { container: ct, image } = input;
  const c = new Collector(input.newDir);
  const oldName = ct.Name.replace(/^\//, "");
  const name = slugify(oldName, "app");
  const img = image?.Config ?? {};
  const svc: Record<string, unknown> = { image: ct.Config.Image };

  const imageEnv = new Set(img.Env ?? []);
  const env = (ct.Config.Env ?? []).filter((e) => !imageEnv.has(e));
  if (env.length) svc.environment = env.map(escapeDollars);
  if (!same(ct.Config.Entrypoint, img.Entrypoint) && ct.Config.Entrypoint) svc.entrypoint = ct.Config.Entrypoint.map(escapeDollars);
  if (!same(ct.Config.Cmd, img.Cmd) && ct.Config.Cmd) svc.command = ct.Config.Cmd.map(escapeDollars);
  if (ct.Config.WorkingDir && ct.Config.WorkingDir !== (img.WorkingDir || "/") && ct.Config.WorkingDir !== img.WorkingDir) svc.working_dir = ct.Config.WorkingDir;
  if (ct.Config.User && ct.Config.User !== (img.User ?? "")) svc.user = ct.Config.User;

  const hc = ct.Config.Healthcheck;
  if (hc?.Test?.length && !same(hc, img.Healthcheck)) {
    if (hc.Test[0] === "NONE") svc.healthcheck = { disable: true };
    else svc.healthcheck = { test: hc.Test.map(escapeDollars), interval: duration(hc.Interval), timeout: duration(hc.Timeout), start_period: duration(hc.StartPeriod), retries: hc.Retries || undefined };
  }

  const h = ct.HostConfig;
  const restart = h.RestartPolicy?.Name;
  if (restart && restart !== "no") svc.restart = restart === "on-failure" && h.RestartPolicy?.MaximumRetryCount ? `on-failure:${h.RestartPolicy.MaximumRetryCount}` : restart;

  // Networks: docker run's default bridge stays the bridge; named networks are joined as they are.
  const mode = h.NetworkMode ?? "default";
  const topNetworks: Record<string, unknown> = {};
  if (mode === "default" || mode === "bridge") svc.network_mode = "bridge";
  else if (mode === "host" || mode === "none") svc.network_mode = mode;
  else if (mode.startsWith("container:")) {
    svc.network_mode = mode;
    c.warn(`It shares the network of another container (${mode.slice("container:".length, "container:".length + 12)}), which has to keep running for the copy to work.`);
  } else {
    const nets: Record<string, unknown> = {};
    for (const n of Object.keys(ct.NetworkSettings?.Networks ?? { [mode]: {} })) {
      if (n === "bridge" || n === "host" || n === "none") continue;
      nets[n] = oldName !== name ? { aliases: [oldName] } : null;
      topNetworks[n] = { external: true };
    }
    if (Object.keys(nets).length) svc.networks = nets;
  }
  const isolated = svc.network_mode === "host" || String(svc.network_mode ?? "").startsWith("container:");
  if (!isolated && ct.Config.Hostname && !ct.Id.startsWith(ct.Config.Hostname)) svc.hostname = ct.Config.Hostname;

  if (!isolated) {
    const ports: string[] = [];
    for (const [spec, binds] of Object.entries(h.PortBindings ?? {})) {
      const [cport, proto = "tcp"] = spec.split("/");
      for (const b of binds ?? []) {
        const ip = b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp.includes(":") ? `[${b.HostIp}]` : b.HostIp}:` : "";
        const suffix = proto === "tcp" ? "" : `/${proto}`;
        ports.push(b.HostPort ? `${ip}${b.HostPort}:${cport}${suffix}` : `${cport}${suffix}`);
      }
    }
    const unique = [...new Set(ports)];
    if (unique.length) svc.ports = unique;
  }

  // Mounts: folders from the server stay; volumes only it uses are copied into the new folder.
  const vols: string[] = [];
  const topVolumes: Record<string, unknown> = {};
  for (const m of ct.Mounts) {
    const ro = m.RW ? "" : ":ro";
    if (m.Type === "bind") {
      const src = norm(m.Source) ?? m.Source;
      c.stay(src, name, !m.RW);
      vols.push(`${src}:${m.Destination}${ro}`);
    } else if (m.Type === "volume" && m.Name) {
      const anon = ANON.test(m.Name);
      const info = input.volumes.find((v) => v.name === m.Name);
      const others = (info?.usedBy ?? []).filter((u) => u !== oldName);
      if (!anon && (others.length || (info && (info.driver !== "local" || info.hasOptions)))) {
        const key = slugify(m.Name, "volume").replace(/-/g, "_");
        topVolumes[key] = { external: true, name: m.Name };
        c.shared.add(m.Name);
        vols.push(`${key}:${m.Destination}${ro}`);
        if (others.length) c.warn(`The volume “${m.Name}” is also used by ${others.join(", ")}, so the copy uses it in place instead of copying it.`);
        continue;
      }
      const folder = anon ? anonFolder(name, m.Destination) : `./volumes/${slugify(m.Name, "volume")}`;
      c.copy(m.Source, path.posix.join(input.newDir, folder.slice(2)), "volume", name, m.Name);
      vols.push(`${folder}:${m.Destination}${ro}`);
    } else if (m.Type === "tmpfs") {
      svc.tmpfs = [...((svc.tmpfs as string[] | undefined) ?? []), m.Destination];
    }
  }
  for (const [dest, opts] of Object.entries(h.Tmpfs ?? {})) svc.tmpfs = [...((svc.tmpfs as string[] | undefined) ?? []), opts ? `${dest}:${opts}` : dest];
  if (vols.length) svc.volumes = vols;

  const devices = (h.Devices ?? []).map((d) => `${d.PathOnHost}:${d.PathInContainer}${d.CgroupPermissions && d.CgroupPermissions !== "rwm" ? `:${d.CgroupPermissions}` : ""}`);
  if (devices.length) svc.devices = devices;
  if (h.Privileged) svc.privileged = true;
  if (h.PidMode === "host") svc.pid = "host";
  if (h.IpcMode === "host") svc.ipc = "host";
  if (h.CgroupnsMode === "host") svc.cgroup = "host";
  if (list(h.CapAdd)) svc.cap_add = h.CapAdd;
  if (list(h.CapDrop)) svc.cap_drop = h.CapDrop;
  if (list(h.SecurityOpt)) svc.security_opt = h.SecurityOpt;
  if (list(h.ExtraHosts)) svc.extra_hosts = h.ExtraHosts;
  if (list(h.Dns)) svc.dns = h.Dns;
  if (list(h.GroupAdd)) svc.group_add = h.GroupAdd;
  if (h.Sysctls && Object.keys(h.Sysctls).length) svc.sysctls = h.Sysctls;
  if (h.Init) svc.init = true;
  if (h.ShmSize && h.ShmSize !== DEFAULT_SHM) svc.shm_size = h.ShmSize;
  if (h.Memory) svc.mem_limit = h.Memory;
  if (h.NanoCpus) svc.cpus = h.NanoCpus / 1e9;
  if (ct.Config.StopSignal && ct.Config.StopSignal !== "SIGTERM") svc.stop_signal = ct.Config.StopSignal;

  const imageLabels = img.Labels ?? {};
  const labels = Object.fromEntries(Object.entries(ct.Config.Labels ?? {}).filter(([k, v]) => !k.startsWith("com.docker.") && imageLabels[k] !== v).map(([k, v]) => [k, escapeDollars(v)]));
  if (Object.keys(labels).length) svc.labels = labels;
  for (const [re, who] of managers) if (Object.keys(ct.Config.Labels ?? {}).some((k) => re.test(k))) c.warn(`${who} manages this container and may start or recreate it. Remove it from ${who} after the move.`);

  const doc: Record<string, unknown> = { name: input.newProject, services: { [name]: svc } };
  if (Object.keys(topNetworks).length) doc.networks = topNetworks;
  if (Object.keys(topVolumes).length) doc.volumes = topVolumes;
  doc["x-gluon"] = gluonMeta(input.meta, "docker", oldName);
  const compose = render(doc, `${input.meta.name}, moved to Gluon from a single container.`);
  return {
    compose,
    envText: null,
    copies: c.finalCopies(),
    stays: [...c.stays.values()],
    sharedVolumes: [...c.shared],
    ports: dedupePorts(publishedPorts(name, svc.ports)),
    warnings: c.warnings,
    blockers: c.blockers,
  };
}
