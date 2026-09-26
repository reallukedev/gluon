"use client";
import * as React from "react";
import { htmlAttrs, uiBits, type Prefs } from "@/lib/prefs";
import { api } from "@/lib/client/api";
import * as f from "@/lib/format";

export interface Viewer {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  mfa: boolean;
  zone: "home" | "away";
  mustChangePassword?: boolean;
}

interface Ctx {
  prefs: Prefs;
  /** The timezone times are shown in (explicit pref, else the browser's). */
  timeZone: string | undefined;
  viewer: Viewer;
  serverName: string;
  /** Optimistically update prefs, persist, roll back on failure. */
  setPrefs: (patch: Partial<Prefs>) => Promise<void>;
}

const PrefsContext = React.createContext<Ctx | null>(null);

export function PrefsProvider({
  initial,
  viewer,
  serverName,
  tz: cookieTz,
  children,
}: {
  initial: Prefs;
  viewer: Viewer;
  serverName: string;
  /** Browser timezone remembered in a cookie so server and client format times identically. */
  tz: string | null;
  children: React.ReactNode;
}) {
  const [prefs, setState] = React.useState(initial);
  const [browserTz, setBrowserTz] = React.useState<string | null>(cookieTz);

  React.useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== cookieTz) {
      document.cookie = `gluon_tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
      setBrowserTz(tz);
    }
  }, [cookieTz]);

  // Reflect appearance prefs on <html> immediately (no reload).
  React.useEffect(() => {
    const el = document.documentElement;
    for (const [k, v] of Object.entries(htmlAttrs(uiBits(prefs)))) el.setAttribute(k, v);
  }, [prefs]);

  const setPrefs = React.useCallback(async (patch: Partial<Prefs>) => {
    let before: Prefs | undefined;
    setState((p) => {
      before = p;
      return { ...p, ...patch };
    });
    try {
      const next = await api.patch<Prefs>("/api/me/prefs", patch);
      setState(next);
    } catch (e) {
      if (before) setState(before);
      throw e;
    }
  }, []);

  const timeZone = prefs.timezone !== "auto" ? prefs.timezone : (browserTz ?? undefined);
  const value = React.useMemo(() => ({ prefs, timeZone, viewer, serverName, setPrefs }), [prefs, timeZone, viewer, serverName, setPrefs]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const c = React.useContext(PrefsContext);
  if (!c) throw new Error("usePrefs outside PrefsProvider");
  return c;
}

export function useViewer() {
  return usePrefs().viewer;
}

/** Formatters bound to the viewer's unit/clock/date preferences. */
export function useFormat() {
  const { prefs: raw, timeZone } = usePrefs();
  const prefs = React.useMemo(() => ({ ...raw, timezone: timeZone ?? "UTC" }), [raw, timeZone]);
  return React.useMemo(
    () => ({
      bytes: (n: number | null | undefined, digits?: number) => f.formatBytes(n, prefs.bytes, digits),
      rate: (n: number | null | undefined) => f.formatRate(n, prefs.rates),
      temp: (c: number | null | undefined) => f.formatTemp(c, prefs.temperature),
      time: (ts: number | Date, seconds?: boolean) => f.formatTime(ts, prefs, seconds),
      date: (ts: number | Date, o?: { year?: boolean; weekday?: boolean }) => f.formatDate(ts, prefs, o),
      dateTime: (ts: number) => f.formatDateTime(ts, prefs),
      relative: f.formatRelative,
      duration: f.formatDuration,
      percent: f.formatPercent,
      plural: f.plural,
    }),
    [prefs],
  );
}
