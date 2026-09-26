import "server-only";
import { docker } from "./client";
import { getApp, type AppSummary } from "./apps";
import { recentDockerEvents, explainExit, type DockerEvent } from "./events";
import { notFound } from "../errors";
import { all } from "../db";

export interface MountInfo {
  type: string;
  source: string;
  destination: string;
  rw: boolean;
  volume?: string;
}

export interface ContainerDetail {
  id: string;
  name: string;
  service: string | null;
  image: string;
  imageId: string;
  state: string;
  health: string | null;
  healthLog: { at: string; exitCode: number; output: string }[];
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  exitExplained: string | null;
  restartCount: number;
  restartPolicy: string;
  oomKilled: boolean;
  networkMode: string;
  networks: { name: string; ip: string | null }[];
  mounts: MountInfo[];
  env: { key: string; value: string; secret: boolean }[];
  ports: { host: number; container: number; proto: string; ip: string }[];
  command: string;
  user: string | null;
  memoryLimit: number | null;
  cpuLimit: number | null;
}

export interface AppDetail extends AppSummary {
  details: ContainerDetail[];
  events: DockerEvent[];
  access: { userId: string }[];
}

const SECRET_KEY = /(pass|secret|token|key|auth|credential|cookie|salt|private|api_?key|dsn)/i;

function parseTime(s: string | undefined): number | null {
  if (!s || s.startsWith("0001")) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export async function appDetail(id: string): Promise<AppDetail> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  const details = await Promise.all(
    app.containers.map(async (c): Promise<ContainerDetail> => {
      const i = await docker().getContainer(c.id).inspect();
      const env = (i.Config.Env ?? []).map((kv) => {
        const eq = kv.indexOf("=");
        const key = eq < 0 ? kv : kv.slice(0, eq);
        const value = eq < 0 ? "" : kv.slice(eq + 1);
        const secret = SECRET_KEY.test(key);
        return { key, value: secret ? "" : value, secret };
      });
      const ports: ContainerDetail["ports"] = [];
      for (const [k, binds] of Object.entries(i.NetworkSettings.Ports ?? {})) {
        const [cport, proto] = k.split("/");
        for (const b of binds ?? []) {
          if (!ports.some((p) => p.host === Number(b.HostPort) && p.proto === proto)) ports.push({ host: Number(b.HostPort), container: Number(cport), proto: proto ?? "tcp", ip: b.HostIp });
        }
      }
      const state = i.State as typeof i.State & { Health?: { Status: string; Log?: { Start: string; ExitCode: number; Output: string }[] } };
      return {
        id: i.Id,
        name: i.Name.replace(/^\//, ""),
        service: i.Config.Labels?.["com.docker.compose.service"] ?? null,
        image: i.Config.Image,
        imageId: i.Image,
        state: i.State.Status,
        health: state.Health?.Status ?? null,
        healthLog: (state.Health?.Log ?? []).slice(-5).map((l) => ({ at: l.Start, exitCode: l.ExitCode, output: l.Output.slice(0, 500) })),
        startedAt: parseTime(i.State.StartedAt),
        finishedAt: parseTime(i.State.FinishedAt),
        exitCode: i.State.Running ? null : i.State.ExitCode,
        exitExplained: i.State.Running ? null : explainExit(i.State.ExitCode),
        restartCount: i.RestartCount ?? 0,
        restartPolicy: i.HostConfig.RestartPolicy?.Name || "no",
        oomKilled: !!i.State.OOMKilled,
        networkMode: i.HostConfig.NetworkMode ?? "default",
        networks: Object.entries(i.NetworkSettings.Networks ?? {}).map(([name, n]) => ({ name, ip: n.IPAddress || null })),
        mounts: (i.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW, volume: m.Name })),
        env: env.sort((a, b) => a.key.localeCompare(b.key)),
        ports: ports.sort((a, b) => a.host - b.host),
        command: [...(i.Config.Entrypoint ?? []), ...(i.Config.Cmd ?? [])].join(" ").slice(0, 400),
        user: i.Config.User || null,
        memoryLimit: i.HostConfig.Memory || null,
        cpuLimit: i.HostConfig.NanoCpus ? i.HostConfig.NanoCpus / 1e9 : null,
      };
    }),
  );
  const names = new Set(app.containers.map((c) => c.name));
  return {
    ...app,
    details,
    events: recentDockerEvents()
      .filter((e) => names.has(e.name) || e.project === id)
      .slice(-40)
      .reverse(),
    access: all<{ user_id: string }>("SELECT user_id FROM app_access WHERE app_id = ?", id).map((r) => ({ userId: r.user_id })),
  };
}

/** Reveal one secret env value (admin, recent auth, audited by the caller). */
export async function revealEnv(appId: string, container: string, key: string): Promise<string> {
  const app = await getApp(appId);
  const c = app?.containers.find((x) => x.name === container);
  if (!c) throw notFound("That container");
  const i = await docker().getContainer(c.id).inspect();
  const kv = (i.Config.Env ?? []).find((e) => e.startsWith(`${key}=`));
  if (!kv) throw notFound("That setting");
  return kv.slice(key.length + 1);
}
