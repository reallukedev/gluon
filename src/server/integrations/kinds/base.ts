import "server-only";
import type { z } from "zod";
import { AppError } from "../../errors";
import { describeNetError, NetError, openStream, safeFetch, type FetchResult, type StreamResult } from "../net";
import type { IntegrationField, IntegrationKind, IntegrationTestResult, WidgetDataMap, WidgetType } from "@/lib/widgets-types";

/** The integration as the kind implementation sees it (config decrypted and validated). */
export interface KindContext<C> {
  /** null while testing an unsaved integration (no image URLs can be issued then). */
  id: string | null;
  name: string;
  baseUrl: string;
  config: C;
  /** Changes whenever the integration is edited; part of cache keys. */
  version: number;
}

export type TestOutcome = Omit<IntegrationTestResult, "ms">;

export interface ImageRequest {
  /** Path + query on the upstream app. */
  path: string;
  query: Record<string, string>;
}

export interface KindDef<C = Record<string, unknown>> {
  kind: IntegrationKind;
  label: string;
  /** How sentences refer to it when the label doesn't read well there ("the music server"). Default: label. */
  noun?: string;
  description: string;
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  keyHelp: string;
  fields: IntegrationField[];
  /** Full config incl. secrets (base URL lives outside, in its own column). */
  schema: z.ZodType<C>;
  /** Top-level config keys stored as secrets (never returned). */
  secretKeys: string[];
  widgets: WidgetType[];
  test(ctx: KindContext<C>): Promise<TestOutcome>;
  data: { [T in WidgetType]?: (ctx: KindContext<C>, params: Record<string, unknown>) => Promise<WidgetDataMap[T]> };
  /** Image proxy support: validate query params → upstream request. */
  image?: {
    schema: z.ZodType<Record<string, string | number>>;
    /** Allowlist key for these params (ids the widgets have handed out). */
    ref(params: Record<string, string | number>): string;
    request(ctx: KindContext<C>, params: Record<string, string | number>): ImageRequest;
  };
  /** Adds auth to an outgoing request (headers and/or query). May be async (e.g. login for a token). */
  authorize?(ctx: KindContext<C>, req: { headers: Record<string, string>; query: Record<string, string> }): Promise<void> | void;
  /** Allow self-signed TLS for this integration. */
  insecureTls?(config: C): boolean;
}

/** An upstream app answered or failed in a way we can explain. Status 502 so the UI shows it on the widget. */
export class UpstreamError extends AppError {
  constructor(message: string, public readonly upstreamStatus: number | null = null, code = "upstream") {
    super(code, message, 502, upstreamStatus ? { status: upstreamStatus } : undefined);
  }
}

export interface CallOptions {
  method?: "GET" | "POST" | "HEAD";
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  maxBytes?: number;
  timeoutMs?: number;
  /** Statuses that should be returned instead of thrown (e.g. [404] to probe for an endpoint). */
  allow?: number[];
  /** Skip `authorize` (login calls). */
  noAuth?: boolean;
}

export function joinUrl(base: string, path: string, query?: Record<string, string>): string {
  const u = new URL(base);
  // Keep any path prefix (Jellyfin at /jellyfin) and any query the admin put in the address.
  if (path) u.pathname = u.pathname.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
  u.hash = "";
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.append(k, v);
  return u.toString();
}

function hostOf(base: string) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** HTTP helpers bound to one integration; errors become human UpstreamErrors naming the app. */
export function client<C>(def: KindDef<C>, ctx: KindContext<C>, authMessage: (status: number, body: string) => string | null) {
  const label = def.noun ?? def.label;
  const Label = label.charAt(0).toUpperCase() + label.slice(1);

  async function prepare(path: string, o: CallOptions) {
    const headers: Record<string, string> = { Accept: "application/json", ...(o.headers ?? {}) };
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null) query[k] = String(v);
    if (!o.noAuth) await def.authorize?.(ctx, { headers, query });
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      headers["Content-Type"] ??= "application/json";
    }
    let url: string;
    try {
      url = joinUrl(ctx.baseUrl, path, query);
    } catch {
      throw new UpstreamError(`The address for ${label} isn't a valid web address.`, null, "bad_url");
    }
    return { url, headers, body };
  }

  function fail(e: unknown): never {
    if (e instanceof AppError) {
      if (e.code === "bad_url" || e.code === "blocked_address") throw new UpstreamError(e.message, null, e.code);
      throw e;
    }
    if (e instanceof NetError) throw new UpstreamError(describeNetError(e, Label, hostOf(ctx.baseUrl)), null, e.code === "timeout" ? "timeout" : "unreachable");
    throw e;
  }

  function checkStatus(r: { status: number }, bodyText: string, o: CallOptions, path: string) {
    if (r.status >= 200 && r.status < 300) return;
    if (o.allow?.includes(r.status)) return;
    if (r.status === 401 || r.status === 403) {
      throw new UpstreamError(authMessage(r.status, bodyText) ?? `${Label} answered ${r.status}: it didn't accept Gluon's credentials.`, r.status, "upstream_auth");
    }
    if (r.status === 404) throw new UpstreamError(`${Label} answered 404${path ? ` for ${path.split("?")[0]}` : ""}: check the address.`, 404);
    if (r.status === 429) throw new UpstreamError(`${Label} is asking Gluon to slow down (429). It will try again shortly.`, 429);
    if (r.status >= 500) throw new UpstreamError(`${Label} answered ${r.status}: it had a problem on its side.`, r.status);
    throw new UpstreamError(`${Label} answered ${r.status}.`, r.status);
  }

  async function raw(path: string, o: CallOptions = {}): Promise<FetchResult> {
    const { url, headers, body } = await prepare(path, o);
    let r: FetchResult;
    try {
      r = await safeFetch(url, {
        method: o.method ?? (body !== undefined ? "POST" : "GET"),
        headers,
        body,
        policy: "trusted",
        timeoutMs: o.timeoutMs ?? 5000,
        maxBytes: o.maxBytes ?? 4 * 1024 * 1024,
        insecureTls: def.insecureTls?.(ctx.config) ?? false,
      });
    } catch (e) {
      fail(e);
    }
    checkStatus(r, r.status >= 400 ? r.body.subarray(0, 2000).toString("utf8") : "", o, path);
    return r;
  }

  async function json<T>(path: string, o: CallOptions = {}): Promise<T> {
    const r = await raw(path, o);
    if (o.allow?.includes(r.status) && (r.status < 200 || r.status >= 300)) return { __status: r.status } as T;
    const text = r.body.toString("utf8");
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      const ct = String(r.headers["content-type"] ?? "");
      throw new UpstreamError(
        ct.includes("html") || /^\s*</.test(text)
          ? `${Label} answered with a web page instead of JSON: check the address.`
          : `${Label} answered with something Gluon couldn't read.`,
        r.status,
      );
    }
  }

  async function stream(path: string, o: CallOptions = {}): Promise<StreamResult> {
    const { url, headers } = await prepare(path, { ...o, headers: { Accept: "image/*", ...(o.headers ?? {}) } });
    let r: StreamResult;
    try {
      r = await openStream(url, {
        method: "GET",
        headers,
        policy: "trusted",
        timeoutMs: o.timeoutMs ?? 5000,
        totalMs: 20_000,
        maxBytes: o.maxBytes ?? 15 * 1024 * 1024,
        insecureTls: def.insecureTls?.(ctx.config) ?? false,
      });
    } catch (e) {
      fail(e);
    }
    if (r.status < 200 || r.status >= 300) {
      r.stream.destroy();
      checkStatus(r, "", o, path);
    }
    return r;
  }

  return { raw, json, stream };
}

/** Wrap a test so every failure becomes a readable `{ ok: false, message }`. */
export async function runTest(fn: () => Promise<TestOutcome>): Promise<TestOutcome> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return fail(e.message);
    console.error("[gluon] integration test crashed", e);
    return fail("The test failed unexpectedly. It's been logged.");
  }
}

export function ok(message: string, extra: Partial<TestOutcome> = {}): TestOutcome {
  return { ok: true, message, detail: null, version: null, serverName: null, options: null, preview: null, ...extra };
}
export function fail(message: string, extra: Partial<TestOutcome> = {}): TestOutcome {
  return { ok: false, message, detail: null, version: null, serverName: null, options: null, preview: null, ...extra };
}

// ------------------------------------------------------------------ small parsing helpers shared by kinds

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
export const time = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === "object" ? [v as T] : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
