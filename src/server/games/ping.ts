import net from "node:net";
import { decodeResponse, encodeLegacyPing, encodeStatusRequest, parseLegacyText } from "./slp";
import type { McPing } from "@/lib/games-types";

/** Words for a failed connection, written to follow "Nothing answered: ". */
function connectError(code: string | undefined): string {
  switch (code) {
    case "ECONNREFUSED":
      return "nothing is listening on that port";
    case "ETIMEDOUT":
      return "no answer in time";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "that address can't be reached from Gluon";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the name doesn't resolve";
    case "ECONNRESET":
      return "the connection was reset";
    default:
      return code ? `the connection failed (${code})` : "the connection failed";
  }
}

const fail = (error: string, at: number): McPing => ({ ok: false, ms: null, version: null, protocol: null, motd: null, online: null, max: null, players: [], favicon: null, error, at });

function once(host: string, port: number, request: Buffer, timeoutMs: number): Promise<{ data: Buffer; ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let data = Buffer.alloc(0);
    let done = false;
    let ms: number | null = null;
    const sock = net.connect({ host, port });
    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ data, ms, error });
    };
    const timer = setTimeout(() => finish(data.length ? "the reply stopped part way" : "no answer in time"), timeoutMs);
    sock.once("connect", () => sock.write(request));
    sock.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (decodeResponse(data).kind !== "incomplete") {
        ms = Date.now() - t0;
        finish(null);
      }
    });
    sock.once("error", (e: NodeJS.ErrnoException) => finish(connectError(e.code)));
    // mc-router closes the connection straight away when it can't reach the server behind an address.
    sock.once("close", () => finish(data.length ? null : "the connection closed without an answer"));
  });
}

/**
 * Ask a Minecraft Java server (or mc-router in front of it) for its status, saying `address` is
 * what the player typed. Falls back to the 1.6 ping when the server only speaks the old one.
 * Never throws.
 */
export async function slpPing(host: string, port: number, address: string, timeoutMs = 5000): Promise<McPing> {
  const at = Date.now();
  const first = await once(host, port, encodeStatusRequest(address, 25565), timeoutMs);
  if (first.error && !first.data.length) return fail(first.error, at);
  let d = decodeResponse(first.data);
  if (d.kind === "legacy-kick" && !parseLegacyText(d.text)) {
    // A pre-1.7 server kicked our modern handshake; ask it the old way.
    const second = await once(host, port, encodeLegacyPing(address, 25565), timeoutMs);
    if (second.error && !second.data.length) return fail(second.error, at);
    d = decodeResponse(second.data);
    first.ms = second.ms;
  }
  if (d.kind === "status") return { ok: true, ms: first.ms, ...d.status, error: null, at };
  if (d.kind === "legacy-kick") {
    const st = parseLegacyText(d.text);
    return st ? { ok: true, ms: first.ms, ...st, error: null, at } : fail("it answered, but not with a server status", at);
  }
  return fail(d.kind === "error" ? d.message : (first.error ?? "the reply stopped part way"), at);
}
