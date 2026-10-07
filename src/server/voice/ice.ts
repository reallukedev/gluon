import "server-only";
import { Ice } from "ice";
import { MumbleServer } from "./generated/MumbleServer";
import { AppError } from "../errors";

/**
 * Talking to Mumble over ZeroC Ice (Mumble 1.5's admin API). One communicator serves every voice
 * server; each call carries that server's secret in its context. Mumble answers with proxies that
 * name its own (container-internal) address, so every proxy is re-pointed at the published port.
 */

type G = typeof globalThis & { __gluonIce?: Ice.Communicator };
const g = globalThis as G;

function communicator(): Ice.Communicator {
  if (g.__gluonIce) return g.__gluonIce;
  const init = new Ice.InitializationData();
  init.properties = Ice.createProperties();
  // Fail fast: an unreachable server is a state to show, not something to wait on.
  init.properties.setProperty("Ice.Override.ConnectTimeout", "2500");
  init.properties.setProperty("Ice.RetryIntervals", "-1");
  init.properties.setProperty("Ice.Warn.Connections", "0");
  init.properties.setProperty("Ice.MessageSizeMax", "65536");
  g.__gluonIce = Ice.initialize(init);
  return g.__gluonIce;
}

export interface IceTarget {
  host: string;
  port: number;
  secret: string;
}

export interface MumbleConn {
  meta: MumbleServer.MetaPrx;
  server: MumbleServer.ServerPrx;
  serverId: number;
  /** Booted virtual servers besides the one Gluon manages (usually none). */
  others: number;
}

const endpoint = (t: Pick<IceTarget, "host" | "port">) => `tcp -h ${t.host} -p ${t.port} -t 8000`;

function metaProxy(t: IceTarget): MumbleServer.MetaPrx {
  const base = communicator().stringToProxy(`Meta:${endpoint(t)}`).ice_context(new Map([["secret", t.secret]])).ice_invocationTimeout(8000);
  return MumbleServer.MetaPrx.uncheckedCast(base);
}

/** Mumble's version over Ice. Needs no secret, so it tells "unreachable" apart from "wrong secret". */
export async function iceVersion(t: Pick<IceTarget, "host" | "port">): Promise<string> {
  const p = MumbleServer.MetaPrx.uncheckedCast(communicator().stringToProxy(`Meta:${endpoint(t)}`).ice_invocationTimeout(5000));
  const [, , , text] = (await p.getVersion()) as unknown as [number, number, number, string];
  return text;
}

/** Connect to the first booted virtual server (Mumble's own default is server 1). */
export async function connect(t: IceTarget): Promise<MumbleConn> {
  const meta = metaProxy(t);
  const booted = await meta.getBootedServers();
  if (!booted.length) throw new AppError("voice_no_server", "Mumble is running but none of its servers is started.", 503);
  const servers = await Promise.all(
    booted.map(async (b) => {
      const s = MumbleServer.ServerPrx.uncheckedCast(b.ice_endpoints(meta.ice_getEndpoints()).ice_context(meta.ice_getContext()).ice_invocationTimeout(8000));
      return { s, id: await s.id() };
    }),
  );
  servers.sort((a, b) => a.id - b.id);
  return { meta, server: servers[0]!.s, serverId: servers[0]!.id, others: servers.length - 1 };
}

/** The Ice exception's type id ("::MumbleServer::InvalidSecretException"), if it is one. */
export function iceId(e: unknown): string | null {
  const err = e as { ice_id?: () => string };
  return typeof err?.ice_id === "function" ? err.ice_id() : null;
}

export function isUnreachable(e: unknown): boolean {
  const id = iceId(e) ?? "";
  return /ConnectionRefused|ConnectTimeout|ConnectFailed|ConnectionLost|Socket|Timeout|DNS|CloseConnection|ConnectionManuallyClosed/.test(id);
}

/** An Ice failure as something a person can act on. */
export function iceError(e: unknown, what = "That"): AppError {
  if (e instanceof AppError) return e;
  const id = iceId(e);
  if (!id) return new AppError("voice_error", `${what} didn't work: ${(e as Error)?.message ?? "Mumble didn't answer."}`, 502);
  const short = id.replace(/^::(MumbleServer|Ice)::/, "");
  const words: Record<string, [string, number]> = {
    InvalidSecretException: ["Mumble refused Gluon's secret. Its Ice secret was changed outside Gluon; let Gluon manage it again to fix that.", 502],
    InvalidSessionException: ["That person isn't connected any more.", 409],
    InvalidChannelException: ["That channel doesn't exist any more. It may have been removed from a Mumble app.", 409],
    InvalidUserException: ["That registration doesn't exist any more.", 409],
    NestingLimitException: ["Channels can't nest that deep on this server.", 400],
    ServerBootedException: ["Mumble's server is stopping or starting. Try again in a moment.", 503],
    InvalidInputDataException: ["Mumble couldn't use that certificate and key.", 400],
    WriteOnlyException: ["Mumble doesn't let anyone read that setting back.", 400],
    InvalidServerException: ["That Mumble server doesn't exist.", 404],
  };
  const w = words[short];
  if (w) return new AppError(`voice_${short}`, w[0], w[1]);
  if (isUnreachable(e)) return new AppError("voice_unreachable", "Gluon couldn't reach Mumble's admin connection. Check that the voice server is running.", 503);
  if (short === "OperationNotExistException") return new AppError("voice_unsupported", "This version of Mumble doesn't support that.", 501);
  return new AppError("voice_error", `${what} didn't work (${short}).`, 502);
}

export { MumbleServer };
