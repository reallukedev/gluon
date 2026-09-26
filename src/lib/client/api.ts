"use client";
import useSWR, { type SWRConfiguration } from "swr";
import * as React from "react";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  get field(): string | undefined {
    return typeof this.details?.field === "string" ? this.details.field : undefined;
  }
}

/**
 * Some actions require recent re-authentication. When the server answers `reauth`, the shell's
 * re-auth dialog asks for the password/code, then we retry once.
 */
type ReauthHandler = () => Promise<boolean>;
const reauthHandlerRef: { current: ReauthHandler | null } = { current: null };
export function setReauthHandler(h: ReauthHandler | null) {
  reauthHandlerRef.current = h;
}

async function request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network", "Can't reach the server. Check your connection and try again.", 0);
  }
  if (res.status === 401 && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
    throw new ApiError("unauthenticated", "You've been signed out.", 401);
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    if (err?.code === "reauth" && !retried && reauthHandlerRef.current) {
      const ok = await reauthHandlerRef.current();
      if (ok) return request<T>(method, url, body, true);
      throw new ApiError("reauth_cancelled", "Cancelled.", 403);
    }
    throw new ApiError(err?.code ?? "http", err?.message ?? `The server answered ${res.status}.`, res.status, err?.details);
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T = { ok: true }>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T = { ok: true }>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T = { ok: true }>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T = { ok: true }>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

const fetcher = (url: string) => api.get<unknown>(url);

/** Polling GET with SWR. `refresh` in ms; pauses automatically when the tab is hidden. */
export function useApi<T>(url: string | null, opts: SWRConfiguration & { refresh?: number } = {}) {
  const { refresh, ...rest } = opts;
  return useSWR<T, ApiError>(url, fetcher as (u: string) => Promise<T>, {
    refreshInterval: refresh,
    revalidateOnFocus: true,
    keepPreviousData: true,
    dedupingInterval: 1000,
    ...rest,
  });
}

/**
 * Subscribe to a Server-Sent Events stream. Reconnects with backoff; stops while the tab is hidden.
 * `handlers` is read through a ref so callers can pass inline objects.
 */
export function useStream(url: string | null, handlers: Record<string, (data: unknown) => void>, deps: React.DependencyList = []) {
  const ref = React.useRef(handlers);
  ref.current = handlers;
  const [status, setStatus] = React.useState<"connecting" | "live" | "offline">("connecting");

  React.useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped || document.hidden) return;
      setStatus("connecting");
      es = new EventSource(url);
      es.onopen = () => {
        retry = 0;
        setStatus("live");
      };
      es.onerror = () => {
        es?.close();
        es = null;
        setStatus("offline");
        if (stopped) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 500 * 2 ** retry);
      };
      for (const event of Object.keys(ref.current)) {
        es.addEventListener(event, (e) => {
          try {
            ref.current[event]?.(JSON.parse((e as MessageEvent).data));
          } catch {
            /* malformed frame */
          }
        });
      }
    };
    const onVis = () => {
      if (document.hidden) {
        es?.close();
        es = null;
      } else if (!es) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
    };
    connect();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearTimeout(timer);
      es?.close();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  return status;
}

/** POST and read a newline-delimited JSON stream (see `ndjson()` on the server). */
export async function streamPost<E = Record<string, unknown>>(url: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal, retried = false): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, credentials: "same-origin" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null;
    if (data?.error?.code === "reauth" && !retried && reauthHandlerRef.current) {
      if (await reauthHandlerRef.current()) return streamPost(url, body, onEvent, signal, true);
      throw new ApiError("reauth_cancelled", "Cancelled.", 403);
    }
    throw new ApiError(data?.error?.code ?? "http", data?.error?.message ?? `The server answered ${res.status}.`, res.status, data?.error?.details);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
}
