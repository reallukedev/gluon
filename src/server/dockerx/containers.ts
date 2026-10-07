import "server-only";
import { StringDecoder } from "node:string_decoder";
import { docker } from "../docker/client";
import { AppError } from "../errors";
import { dockerError, findContainer } from "./core";
import type { ContainerInspect, ExecEvent } from "@/lib/docker-types";

const SECRET_KEY = /(pass|secret|token|key|auth|credential|cookie|salt|private|api_?key|dsn)/i;

function parseTime(s: string | undefined): number | null {
  if (!s || s.startsWith("0001")) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Docker's inspect output, readable, with secret-looking environment values hidden. */
export async function inspectContainer(idOrName: string): Promise<ContainerInspect> {
  const { info, ref } = await findContainer(idOrName);
  let i: Awaited<ReturnType<ReturnType<ReturnType<typeof docker>["getContainer"]>["inspect"]>>;
  try {
    i = await docker().getContainer(info.Id).inspect();
  } catch (e) {
    throw dockerError(e, "Couldn't read that container");
  }
  const raw = JSON.parse(JSON.stringify(i)) as typeof i;
  raw.Config.Env = (raw.Config.Env ?? []).map((kv) => {
    const eq = kv.indexOf("=");
    const key = eq < 0 ? kv : kv.slice(0, eq);
    return SECRET_KEY.test(key) && eq >= 0 ? `${key}=•••••• (hidden)` : kv;
  });
  const ports: ContainerInspect["ports"] = [];
  for (const [k, binds] of Object.entries(i.NetworkSettings.Ports ?? {})) {
    const [cport, proto] = k.split("/");
    for (const b of binds ?? []) {
      if (!ports.some((p) => p.host === Number(b.HostPort) && p.proto === proto)) ports.push({ host: Number(b.HostPort), container: Number(cport), proto: proto ?? "tcp", ip: b.HostIp });
    }
  }
  const health = (i.State as { Health?: { Status?: string } }).Health?.Status ?? null;
  return {
    id: i.Id,
    name: ref.name,
    state: i.State.Status,
    line: ref.line,
    health: health && health !== "none" ? health : null,
    app: ref.app,
    self: ref.self,
    platform: ref.platform,
    image: { ref: i.Config.Image, id: i.Image },
    created: Date.parse(i.Created),
    startedAt: parseTime(i.State.StartedAt),
    finishedAt: parseTime(i.State.FinishedAt),
    exitCode: i.State.Running ? null : i.State.ExitCode,
    restartCount: i.RestartCount ?? 0,
    restartPolicy: i.HostConfig.RestartPolicy?.Name || "no",
    command: (i.Config.Cmd ?? []).join(" "),
    entrypoint: (Array.isArray(i.Config.Entrypoint) ? i.Config.Entrypoint : i.Config.Entrypoint ? [i.Config.Entrypoint] : []).join(" "),
    workingDir: i.Config.WorkingDir || null,
    user: i.Config.User || null,
    networkMode: i.HostConfig.NetworkMode ?? "default",
    ports: ports.sort((a, b) => a.host - b.host),
    mounts: (i.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW, volume: m.Name ?? null })),
    networks: Object.entries(i.NetworkSettings.Networks ?? {}).map(([name, n]) => ({ name, ipv4: n.IPAddress || null, ipv6: n.GlobalIPv6Address || null })),
    labels: Object.keys(i.Config.Labels ?? {}).length,
    raw,
  };
}

// ---------------------------------------------------------------- one-off commands

const MAX_OUTPUT = 1024 * 1024;

export interface PreparedExec {
  id: string;
  name: string;
  argv: string[];
  user: string | undefined;
  workdir: string | undefined;
  timeoutSec: number;
}

/**
 * Run one command inside a running container, without a terminal or input, and stream what it
 * prints. It's stopped after the time limit (Gluon shares the host's process table, so it can
 * signal the process directly), and output past 1 MB is dropped.
 */
export async function execInContainer(p: PreparedExec, emit: (e: ExecEvent) => void, signal: AbortSignal): Promise<{ exitCode: number | null; argv: string[]; name: string; timedOut: boolean }> {
  const { argv, user, workdir } = p;
  const info = { Id: p.id };
  const ref = { name: p.name };
  const input = { timeoutSec: p.timeoutSec };
  const ctr = docker().getContainer(info.Id);
  let exec: Awaited<ReturnType<typeof ctr.exec>>;
  try {
    exec = await ctr.exec({ Cmd: argv, AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, User: user, WorkingDir: workdir });
  } catch (e) {
    throw dockerError(e, "Couldn't start the command");
  }
  emit({ type: "start", argv });
  const started = Date.now();
  let sent = 0;
  let truncated = false;
  const forward = (kind: "out" | "err") => {
    const dec = new StringDecoder("utf8");
    return {
      write(chunk: Buffer) {
        if (truncated) return true;
        let text = dec.write(chunk);
        if (sent + text.length > MAX_OUTPUT) {
          text = text.slice(0, Math.max(0, MAX_OUTPUT - sent));
          truncated = true;
        }
        sent += text.length;
        if (text) emit({ type: kind, text });
        return true;
      },
    };
  };

  let stream: NodeJS.ReadableStream;
  try {
    stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
  } catch (e) {
    throw dockerError(e, "Couldn't start the command");
  }
  const out = forward("out");
  const err = forward("err");
  docker().modem.demuxStream(stream, out as unknown as NodeJS.WritableStream, err as unknown as NodeJS.WritableStream);

  let timedOut = false;
  const kill = async () => {
    try {
      const st = await exec.inspect();
      if (st.Running && st.Pid) {
        process.kill(st.Pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(st.Pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000);
      }
    } catch {
      /* can't reach it; stop waiting anyway */
    }
  };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      void kill().then(() => setTimeout(resolve, 2500));
    }, input.timeoutSec * 1000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      void kill().then(done);
    });
  });
  let exitCode: number | null = null;
  try {
    const st = await exec.inspect();
    exitCode = st.Running ? null : (st.ExitCode ?? null);
  } catch {
    /* container went away */
  }
  emit({ type: "done", exitCode, ms: Date.now() - started, truncated, timedOut });
  return { exitCode, argv, name: ref.name, timedOut };
}
