import "server-only";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "./errors";
import { CommandError } from "./host/exec";
import { currentAuth, hasRecentAuth, mustSetUpMfa, pendingAuth, type Session } from "./auth/session";
import { mfaRequiredMessage } from "./auth/policy";
import type { User } from "./auth/users";
import { clientInfo, type Zone } from "./net-zone";
import { burst as burstLimit, waitText } from "./auth/ratelimit";

type AuthLevel = "public" | "user" | "admin";

export interface Ctx<B, Q> {
  req: NextRequest;
  user: User;
  session: Session;
  body: B;
  query: Q;
  params: Record<string, string | string[]>;
  ip: string;
  zone: Zone;
}

export interface PublicCtx<B, Q> extends Omit<Ctx<B, Q>, "user" | "session"> {
  user: User | null;
  session: Session | null;
}

interface Options<B, Q> {
  auth: AuthLevel;
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /** Require a password/2FA re-entry within the last 10 minutes. */
  recent?: boolean;
  /** Flood control per client address (in memory): at most `limit` requests per `windowMs`. */
  burst?: { limit: number; windowMs: number };
  /** Largest JSON body accepted, in bytes (default 8 MB). */
  maxBody?: number;
}

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

/** Read a JSON body without ever buffering more than `max` bytes. */
async function readJson(req: NextRequest, max: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new AppError("too_large", "That request is too large.", 413);
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("too_large", "That request is too large.", 413);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("bad_json", "The request body wasn't valid JSON.");
  }
}

const JSON_HEADERS = { "Cache-Control": "no-store" };

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { ...JSON_HEADERS, ...init?.headers } });
}

export function errorResponse(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

function zodMessage(err: z.ZodError): { message: string; field?: string } {
  const issue = err.issues[0];
  if (!issue) return { message: "Some of that didn't look right." };
  const field = issue.path.join(".");
  const msg = issue.message && !issue.message.startsWith("Invalid") ? issue.message : `Check ${field || "the form"}.`;
  return { message: msg, field: field || undefined };
}

/**
 * Same-origin check for state-changing requests (CSRF). Browsers send `Sec-Fetch-Site` (all current
 * ones) and `Origin` on every cross-origin POST/PUT/PATCH/DELETE, including plain HTML form posts, so
 * a request carrying neither is not from a web page (curl, scripts) and can't be a forgery. The
 * session cookie is also SameSite=Lax, so a cross-site form post arrives without it anyway.
 */
function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return !!host && new URL(origin).host === host;
  } catch {
    return false; // "null" (sandboxed frames, data: URLs) and garbage
  }
}

/**
 * Reads can be triggered cross-site too (an <img> or <script> tag pointing at /api/…), which matters
 * for GETs that make the server do work (fetch a URL, run a command). Only same-origin requests and
 * top-level navigations (opening a link to a file) may read the API.
 */
function readAllowed(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return true;
  return req.headers.get("sec-fetch-mode") === "navigate" && req.headers.get("sec-fetch-dest") === "document";
}

type Handler<B, Q> = (ctx: Ctx<B, Q>) => unknown | Promise<unknown>;
type PublicHandler<B, Q> = (ctx: PublicCtx<B, Q>) => unknown | Promise<unknown>;

/** What someone who must set up two-step sign-in may reach: at home, setting it up; away, only leaving. */
const MFA_SETUP_PATH = /^\/api\/(auth\/|me(\/mfa(\/.*)?)?$|shell$)/;
const SIGN_OUT_PATH = /^\/api\/(auth\/|me$|shell$)/;
/** What someone who must pick a new password may reach before they do. */
const PASSWORD_CHANGE_PATH = /^\/api\/(auth\/|me(\/password)?$|shell$)/;

export function route<B = undefined, Q = undefined>(opts: Options<B, Q> & { auth: "public" }, fn: PublicHandler<B, Q>): (req: NextRequest, rc: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
export function route<B = undefined, Q = undefined>(opts: Options<B, Q> & { auth: "user" | "admin" }, fn: Handler<B, Q>): (req: NextRequest, rc: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
export function route<B, Q>(opts: Options<B, Q>, fn: Handler<B, Q> | PublicHandler<B, Q>) {
  return async (req: NextRequest, rc: { params: Promise<Record<string, string | string[]>> }): Promise<Response> => {
    let isAdmin = false;
    try {
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (mutating ? !sameOrigin(req) : !readAllowed(req)) {
        return errorResponse("cross_origin", "That request came from another site and was blocked.", 403);
      }
      const { ip, zone } = clientInfo(req.headers);
      if (opts.burst) {
        const wait = burstLimit(`${req.nextUrl.pathname}:${ip}`, opts.burst.limit, opts.burst.windowMs);
        if (wait > 0) return errorResponse("rate_limited", `Too many requests. Try again in ${waitText(wait)}.`, 429, { retryAfter: wait });
      }

      const auth = opts.auth === "public" ? await pendingAuth() : await currentAuth();
      if (opts.auth !== "public") {
        if (!auth) return errorResponse("unauthenticated", "You've been signed out. Sign in again to continue.", 401);
        if (opts.auth === "admin" && auth.user.role !== "admin") {
          return errorResponse("forbidden", "Only admins can do that.", 403);
        }
        // Setting it up only happens at home: from away, a stolen cookie could enrol its own phone.
        if (mustSetUpMfa(auth.user, zone) && !(zone === "home" ? MFA_SETUP_PATH : SIGN_OUT_PATH).test(req.nextUrl.pathname)) {
          return errorResponse(zone === "home" ? "mfa_required" : "mfa_required_away", mfaRequiredMessage(auth.user.role), 403);
        }
        if (auth.user.mustChangePassword && !PASSWORD_CHANGE_PATH.test(req.nextUrl.pathname)) {
          return errorResponse("must_change_password", "Choose a new password before doing anything else.", 403);
        }
        if (opts.recent && !hasRecentAuth(auth.session)) {
          return errorResponse("reauth", "Confirm it's you to continue.", 403);
        }
      }
      isAdmin = auth?.user.role === "admin" && !auth.session.mfaPending;

      let body = undefined as B;
      if (opts.body) {
        let raw: unknown = {};
        const type = req.headers.get("content-type") ?? "";
        if (type.includes("application/json")) raw = await readJson(req, opts.maxBody ?? DEFAULT_MAX_BODY);
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          const { message, field } = zodMessage(parsed.error);
          return errorResponse("invalid", message, 400, field ? { field } : undefined);
        }
        body = parsed.data;
      }

      let query = undefined as Q;
      if (opts.query) {
        const parsed = opts.query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
        if (!parsed.success) {
          const { message, field } = zodMessage(parsed.error);
          return errorResponse("invalid", message, 400, field ? { field } : undefined);
        }
        query = parsed.data;
      }

      const params = (await rc?.params) ?? {};
      const result = await (fn as Handler<B, Q>)({
        req,
        user: auth?.user as User,
        session: auth?.session as Session,
        body,
        query,
        params,
        ip,
        zone,
      });
      if (result instanceof Response) return result;
      return json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return errorResponse(e.code, e.message, e.status, e.details);
      if (e instanceof CommandError) {
        console.error(`[gluon] command failed: ${e.cmd}\n${e.stderr}`);
        // Command lines and their output are for admins; everyone else gets a plain sentence.
        return isAdmin
          ? errorResponse("command_failed", e.message || "The server couldn't finish that.", 500, { command: e.cmd.split(" ").slice(0, 8).join(" ") })
          : errorResponse("command_failed", "The server couldn't finish that. It's been logged.", 500);
      }
      console.error("[gluon] unhandled", e);
      return errorResponse("internal", "Something went wrong on the server. It's been logged.", 500);
    }
  };
}

/**
 * Server-Sent Events. `start` receives `send` and returns a cleanup function; it runs until the
 * client disconnects. A heartbeat comment every 20 s keeps proxies from closing the stream.
 */
export function sse(req: NextRequest, start: (send: (event: string, data: unknown) => void, close: () => void) => (() => void) | void | Promise<(() => void) | void>) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | void;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          cleanup?.();
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      req.signal.addEventListener("abort", close);
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            close();
          }
        }
      }, 20_000);
      try {
        cleanup = await start(send, close);
      } catch (e) {
        send("error", { message: e instanceof AppError ? e.message : "The live stream stopped." });
        close();
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      try {
        cleanup?.();
      } catch {
        /* ignore */
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Stream newline-delimited JSON from a POST handler (long operations: compose apply, updates).
 * The client reads it with `readNdjson()`. Errors thrown inside become a final {type:"error"} line.
 */
export function ndjson(run: (emit: (event: unknown) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client went away */
        }
      };
      try {
        await run(emit, signal);
      } catch (e) {
        emit({ type: "error", message: e instanceof AppError ? e.message : "Something went wrong on the server. It's been logged." });
        if (!(e instanceof AppError)) console.error("[gluon] stream failed", e);
      } finally {
        try {
          controller.close();
        } catch {
          /* closed */
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
