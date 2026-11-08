"use client";
import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";
import * as React from "react";
import { noteServerTime, useSeedAge } from "./seed";

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
  const sentAt = Date.now();
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
  // Date has whole seconds, so the server's clock was at most a second past it.
  const date = res.headers.get("date");
  if (date) noteServerTime(Date.parse(date) + 1000, sentAt);
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

/** When each key last got an answer (or came with the page), so coming back to the tab knows what is out of date. */
const answeredAt = new Map<string, number>();

const fetcher = async (url: string) => {
  const data = await api.get<unknown>(url);
  answeredAt.set(url, Date.now());
  return data;
};

/** Everything that reads /api/status outside the Status page polls at one pace, so SWR makes one request. */
export const STATUS_KEY = "/api/status";
export const STATUS_REFRESH = 15_000;

/**
 * Data younger than this isn't refetched when a hook mounts: a few seconds, or half a minute for what the page
 * only polls every minute or slower anyway. Never longer than the key's own poll.
 */
const freshFor = (refresh?: number) => (refresh && refresh >= 60_000 ? 30_000 : Math.min(5000, refresh || 5000));
/** Coming back to the tab refetches what is older than this, or than the key's poll if that is shorter. */
const FOCUS_STALE = 15_000;

/**
 * The mounted keys, each with how stale it may get and a way to revalidate it. One listener for all of them, so
 * coming back to Gluon refetches what is out of date, once per key, instead of every hook on the page at once.
 */
type FocusWatch = { stale: number; revalidate: () => void };
const focusKeys = new Map<string, FocusWatch[]>();

function onFocus() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  for (const [key, watches] of focusKeys) {
    if (now - (answeredAt.get(key) ?? 0) < Math.min(...watches.map((w) => w.stale))) continue;
    answeredAt.set(key, now);
    watches[0]!.revalidate();
  }
}

function watchFocus(key: string, watch: FocusWatch) {
  if (!focusKeys.size) {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
  }
  const watches = focusKeys.get(key) ?? [];
  watches.push(watch);
  focusKeys.set(key, watches);
  return () => {
    watches.splice(watches.indexOf(watch), 1);
    if (!watches.length) focusKeys.delete(key);
    if (!focusKeys.size) {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    }
  };
}

/** Polling GET with SWR. `refresh` in ms; pauses automatically when the tab is hidden. */
const noSubscribe = () => () => {};

export function useApi<T>(url: string | null, opts: SWRConfiguration & { refresh?: number } = {}) {
  const { refresh, revalidateOnFocus = true, ...rest } = opts;
  const { fallback, cache } = useSWRConfig();
  const hydrated = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  // Data the server handed over (fallbackData, or an SWRConfig fallback for this key) is what it rendered.
  const seeded = url !== null && (rest.fallbackData !== undefined || fallback[url] !== undefined);
  const seedAge = useSeedAge(!hydrated);
  // How old the data this hook starts with is: an answer already in the cache, or what the server read for the
  // page. If it's that recent, refetching on mount would only ask the host the same question twice. Older (a page
  // prefetched a while back, say) or unknown, it revalidates as usual.
  const ageNow = () => {
    if (url === null) return null;
    const cachedAt = cache.get(url)?.data !== undefined ? answeredAt.get(url) : undefined;
    const age = cachedAt !== undefined ? Date.now() - cachedAt : seeded ? seedAge() : null;
    return age !== null && age >= 0 && age < freshFor(refresh) ? age : null;
  };
  const [start, setStart] = React.useState(() => ({ url, age: ageNow() }));
  // A new key is a new start (the same rule, for its own data).
  if (start.url !== url) setStart({ url, age: ageNow() });
  const startAge = start.url === url ? start.age : null;
  const res = useSWR<T, ApiError>(url, fetcher as (u: string) => Promise<T>, {
    refreshInterval: refresh,
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 1000,
    ...(startAge !== null ? { revalidateOnMount: false } : {}),
    ...rest,
  });
  const { mutate } = res;
  React.useEffect(() => {
    if (!url) return;
    if (startAge !== null) answeredAt.set(url, Math.max(answeredAt.get(url) ?? 0, Date.now() - startAge));
    if (!revalidateOnFocus) return;
    return watchFocus(url, { stale: Math.min(FOCUS_STALE, refresh || FOCUS_STALE), revalidate: () => void mutate() });
  }, [url, startAge, revalidateOnFocus, refresh, mutate]);
  // A part of the page that hydrates late (slow Safari, Suspense) can find its data already cached.
  // Render what the server rendered until hydration is over, or React throws the page's HTML away.
  if (hydrated || seeded) return res;
  return {
    get data() { return undefined; },
    get error() { return undefined; },
    get isLoading() { return true; },
    get isValidating() { return res.isValidating; },
    mutate: res.mutate,
  } as typeof res;
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
  const emit = (line: string) => {
    if (!line) return;
    let e: E;
    try {
      e = JSON.parse(line) as E;
    } catch {
      return; // a torn or non-JSON line (a proxy's error page) isn't an event
    }
    onEvent(e);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      emit(line);
    }
  }
  // The last event may arrive without a trailing newline; dropping it can lose the final result.
  emit((buf + dec.decode()).trim());
}
