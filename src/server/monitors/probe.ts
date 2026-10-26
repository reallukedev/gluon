import "server-only";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { MonitorConfig } from "@/lib/alerts-types";

/**
 * One check. Errors are short, stable phrases ("connection refused", "no answer within 10 s") because
 * they end up in finding causes and the check log; stable wording also stops findings churning.
 */

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
  /** The port answered but not with HTTP (lenient monitors count this as up). */
  notHttp?: boolean;
}

const MAX_BODY = 1024 * 1024;
const MAX_REDIRECTS = 5;

function describe(e: unknown, timeoutSec: number): { error: string; notHttp?: boolean } {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  if (code === "GLUON_TIMEOUT" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return { error: `no answer within ${timeoutSec} s` };
  if (code === "ECONNREFUSED") return { error: "connection refused" };
  if (code === "ENOTFOUND") return { error: "address not found (DNS)" };
  if (code === "EAI_AGAIN") return { error: "DNS lookup failed" };
  if (code === "ECONNRESET" || code === "EPIPE") return { error: "connection dropped" };
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return { error: "host unreachable" };
  if (code === "EPROTO" || /wrong version number/i.test(err.message ?? "")) return { error: "TLS handshake failed (is it really https?)" };
  if (code.startsWith("HPE_")) return { error: "not an HTTP response", notHttp: true };
  if (code === "CERT_HAS_EXPIRED") return { error: "certificate expired" };
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return { error: "certificate is for a different name" };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { error: `certificate not trusted (${code})` };
  return { error: (err.message ?? "check failed").slice(0, 120) };
}

interface Hop {
  status: number;
  location: string | null;
  body: string | null;
  ttfb: number;
}

function request(url: URL, cfg: MonitorConfig, deadline: number, readBody: boolean, t0: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const remaining = Math.max(1, deadline - performance.now());
    const req = mod.request(
      url,
      {
        method: cfg.method,
        agent: false,
        rejectUnauthorized: !cfg.ignoreTls,
        headers: { "User-Agent": "Gluon-Monitor/1 (+uptime check)", Accept: "*/*", Connection: "close" },
      },
      (res) => {
        const ttfb = performance.now() - t0;
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const isRedirect = status >= 300 && status < 400 && !!location;
        if (!readBody || isRedirect || cfg.method === "HEAD") {
          res.destroy();
          clearTimeout(timer);
          return resolve({ status, location, body: null, ttfb });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size >= MAX_BODY) return;
          chunks.push(c);
          size += c.length;
          if (size >= MAX_BODY) res.destroy();
        });
        const done = () => {
          clearTimeout(timer);
          resolve({ status, location, body: Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8"), ttfb });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    const timer = setTimeout(() => {
      const e = new Error("timeout") as Error & { code: string };
      e.code = "GLUON_TIMEOUT";
      req.destroy(e);
    }, remaining);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

export async function probeHttp(target: string, cfg: MonitorConfig): Promise<ProbeResult> {
  const t0 = performance.now();
  const deadline = t0 + cfg.timeoutSec * 1000;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, latencyMs: null, status: null, error: "the address isn't valid" };
  }
  const readBody = !!cfg.keyword;
  try {
    let hop: Hop | null = null;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      hop = await request(url, cfg, deadline, readBody, t0);
      const redirect = hop.status >= 300 && hop.status < 400 && hop.location;
      if (!redirect || !cfg.followRedirects) break;
      if (i === MAX_REDIRECTS) return { ok: false, latencyMs: Math.round(hop.ttfb), status: hop.status, error: "too many redirects" };
      const next = new URL(hop.location!, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") break;
      url = next;
    }
    const h = hop!;
    const latencyMs = Math.round(h.ttfb);
    if (h.status < cfg.expectStatus.min || h.status > cfg.expectStatus.max) {
      return { ok: false, latencyMs, status: h.status, error: `answered ${h.status}` };
    }
    if (cfg.keyword) {
      const found = (h.body ?? "").includes(cfg.keyword);
      if (found === cfg.keywordAbsent) {
        return { ok: false, latencyMs, status: h.status, error: cfg.keywordAbsent ? `“${cfg.keyword}” is on the page` : `“${cfg.keyword}” isn't on the page` };
      }
    }
    return { ok: true, latencyMs, status: h.status, error: null };
  } catch (e) {
    const d = describe(e, cfg.timeoutSec);
    return { ok: false, latencyMs: null, status: null, error: d.error, notHttp: d.notHttp };
  }
}

export function probeTcp(host: string, port: number, timeoutSec: number): Promise<ProbeResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host, port });
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, latencyMs: null, status: null, error: `no answer within ${timeoutSec} s` }), timeoutSec * 1000);
    sock.once("connect", () => finish({ ok: true, latencyMs: Math.round(performance.now() - t0), status: null, error: null }));
    sock.on("error", (e) => finish({ ok: false, latencyMs: null, status: null, error: describe(e, timeoutSec).error }));
  });
}
