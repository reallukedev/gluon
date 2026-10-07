import "server-only";
import { spawn } from "node:child_process";
import net from "node:net";
import type { NextRequest } from "next/server";
import { docker } from "../docker/client";
import { clientInfo, PEER_HEADER, parseAddr } from "../net-zone";
import { getSetting } from "../settings";
import { safeEqual } from "../crypto";
import { GIT_ENV, REPO_NAME, STORE_DIR } from "./repo";
import { getStoreRow } from "./db";

/**
 * Serves Gluon's app store to Umbrel over git's smart HTTP protocol (Umbrel clones stores with
 * isomorphic-git, which speaks nothing else). Every request is handed to `git http-backend` as a
 * CGI with a fixed argument list and a fixed environment; only the two read-only endpoints of
 * upload-pack are allowed, so nothing can be pushed.
 *
 * Who may read it:
 * - the URL carries a random 256-bit token (the store id alone isn't secret);
 * - the peer must be this server (loopback) or a container on one of Docker's networks, which is
 *   where Umbrel runs; a request that came through a proxy for someone else, or that names the
 *   public hostname, is refused.
 */

type G = typeof globalThis & { __gluonDockerNets?: { at: number; list: net.BlockList } };
const g = globalThis as G;

async function dockerSubnets(): Promise<net.BlockList> {
  const c = g.__gluonDockerNets;
  if (c && Date.now() - c.at < 60_000) return c.list;
  const list = new net.BlockList();
  try {
    for (const n of await docker().listNetworks()) {
      for (const cfg of n.IPAM?.Config ?? []) {
        const [addr, bits] = String(cfg.Subnet ?? "").split("/");
        const type = net.isIPv4(addr ?? "") ? "ipv4" : net.isIPv6(addr ?? "") ? "ipv6" : null;
        if (addr && type && bits) list.addSubnet(addr, Number(bits), type);
      }
    }
  } catch {
    // Docker unreachable: trust no container networks (loopback still works) and don't cache the
    // empty answer, so the next request asks Docker again. Guessing at default ranges would also
    // trust anything else on a 10/8 or 172.16/12 home network.
    return list;
  }
  g.__gluonDockerNets = { at: Date.now(), list };
  return list;
}

const LOOPBACK = (() => {
  const l = new net.BlockList();
  l.addSubnet("127.0.0.0", 8, "ipv4");
  l.addAddress("::1", "ipv6");
  return l;
})();

async function allowedPeer(addr: string | null): Promise<boolean> {
  const a = parseAddr(addr);
  if (!a) return false;
  const type = net.isIPv4(a) ? "ipv4" : "ipv6";
  if (LOOPBACK.check(a, type)) return true;
  return (await dockerSubnets()).check(a, type);
}

export async function peerAllowed(req: NextRequest): Promise<boolean> {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const pub = getSetting("publicHost").toLowerCase();
  if (pub && host === pub) return false;
  const { ip } = clientInfo(req.headers);
  if (!(await allowedPeer(ip))) return false;
  // In production the entry point stamps the socket's own peer; it must pass too.
  const stamped = req.headers.get(PEER_HEADER);
  if (stamped && !(await allowedPeer(stamped))) return false;
  return true;
}

const notFound = () => new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

/** Handle /api/appstore/<token>/<storeId>.git/<rest>. */
export async function serveGit(req: NextRequest, segments: string[]): Promise<Response> {
  const store = getStoreRow();
  const [token, repo, ...rest] = segments;
  if (!store || !token || !repo || !safeEqual(token, store.token) || repo !== `${store.storeId}.git`) return notFound();
  if (!(await peerAllowed(req))) return new Response("Forbidden\n", { status: 403, headers: { "Content-Type": "text/plain" } });

  const sub = rest.join("/");
  const service = req.nextUrl.searchParams.get("service");
  const refs = req.method === "GET" && sub === "info/refs" && service === "git-upload-pack";
  const pack = req.method === "POST" && sub === "git-upload-pack";
  if (!refs && !pack) return notFound();

  let body: Buffer | null = null;
  if (pack) {
    const max = 16 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = req.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => undefined);
          return new Response("Request too large\n", { status: 413 });
        }
        chunks.push(value);
      }
    }
    body = Buffer.concat(chunks);
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...GIT_ENV,
    GIT_PROJECT_ROOT: STORE_DIR,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${REPO_NAME}/${sub}`,
    QUERY_STRING: refs ? "service=git-upload-pack" : "",
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    REMOTE_ADDR: clientInfo(req.headers).ip,
    SERVER_PROTOCOL: "HTTP/1.1",
  };
  if (body) env.CONTENT_LENGTH = String(body.length);
  const encoding = req.headers.get("content-encoding");
  if (encoding && /^(gzip|x-gzip)$/i.test(encoding)) env.HTTP_CONTENT_ENCODING = encoding.toLowerCase();
  const protocol = req.headers.get("git-protocol");
  if (protocol && /^[A-Za-z0-9=:._-]{1,100}$/.test(protocol)) env.GIT_PROTOCOL = protocol;

  const child = spawn("git", ["http-backend"], { env: env as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-2000)));
  child.on("close", () => clearTimeout(killer));
  child.stdin.on("error", () => undefined);
  child.stdin.end(body ?? undefined);

  // Read the CGI header block, then stream the rest through.
  const head = await new Promise<{ status: number; headers: Headers; rest: Buffer } | null>((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let end = buf.indexOf("\r\n\r\n");
      let sep = 4;
      if (end < 0) {
        end = buf.indexOf("\n\n");
        sep = 2;
      }
      if (end < 0) {
        if (buf.length > 64 * 1024) done(null);
        return;
      }
      const headers = new Headers();
      let status = 200;
      for (const line of buf.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]) || 200;
        else headers.append(k, v);
      }
      done({ status, headers, rest: buf.subarray(end + sep) });
    };
    const done = (v: { status: number; headers: Headers; rest: Buffer } | null) => {
      child.stdout.pause();
      child.stdout.off("data", onData);
      child.off("close", onClose);
      resolve(v);
    };
    const onClose = () => done(null);
    child.stdout.on("data", onData);
    child.on("close", onClose);
    child.on("error", () => done(null));
  });
  if (!head) {
    console.error(`[gluon] git http-backend failed: ${stderr.trim()}`);
    return new Response("The app store couldn't answer.\n", { status: 502 });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.rest.length) controller.enqueue(new Uint8Array(head.rest));
      child.stdout.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
      child.stdout.on("end", () => {
        try {
          controller.close();
        } catch {
          /* closed */
        }
      });
      child.on("error", (e) => controller.error(e));
      child.stdout.resume();
    },
    cancel() {
      child.kill("SIGKILL");
    },
  });
  head.headers.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
  head.headers.delete("Content-Length");
  return new Response(stream, { status: head.status, headers: head.headers });
}
