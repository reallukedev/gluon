"use client";
// Small pieces every Home widget shares: rows that fit, "set me up" actions, and data-age notes.
import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Time } from "@/components/ui/Time";
import { useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import k from "./kit.module.css";

export { WidgetState } from "./live/shared";

/**
 * How many children of a list fit inside it without being cut. The list keeps rendering every row (hidden ones are
 * clipped by its overflow), so a count like "3 more" is always true to what's on screen.
 */
export function useFit<T extends HTMLElement>(count: number): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [fit, setFit] = React.useState(count);
  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let n = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const r = child.getBoundingClientRect();
      if (r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5) n++;
      else break;
    }
    setFit((f) => (f === n ? f : n));
  }, []);
  // After every render (rows change height when their data does) and whenever the widget is resized.
  React.useLayoutEffect(measure);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, count > 0]);
  return [ref, Math.min(fit, count)];
}

/** The one action an unconfigured widget offers: open its own settings. */
export function SetUp({ openSettings, children }: { openSettings?: () => void; children: React.ReactNode }) {
  if (!openSettings) return null;
  return (
    <Button size="sm" onClick={openSettings}>
      {children}
    </Button>
  );
}

/** "Updated 6 min ago", shown only when data is older than it should be (a failing refresh, a paused sampler). */
export function Age({ at, expectMs, className }: { at: number | null | undefined; expectMs: number; className?: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!at || now - at < expectMs) return null;
  return (
    <span className={`${k.age} ${className ?? ""}`} title="Gluon couldn't refresh this. It keeps trying.">
      Updated <Time ts={at} />
    </span>
  );
}

/** Drives mounted under /mnt or /media read better by what they are ("2.0 TB hard drive") than by a serial-number folder. */
export function useDriveNames() {
  const { data } = useApi<{ places: { label: string; path: string; section?: string }[] }>("/api/files/places", { refresh: 300_000, revalidateOnFocus: false });
  return React.useMemo(
    () => new Map((data?.places ?? []).filter((p) => p.section === "drives" && /^\/(mnt|media)\//.test(p.path)).map((p) => [p.path, p.label] as const)),
    [data],
  );
}

/** Size of an element, kept current as the widget is resized. */
export function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = React.useRef<T>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e!.contentRect.width), h: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export { useReducedMotion } from "@/lib/client/motion";

// ---------------------------------------------------------------- the viewer's day

function zoneOffset(ts: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ts);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ts / 1000) * 1000;
}

/** Midnight at the start of `ts`'s day in `tz` (the viewer's time zone preference), as epoch ms. */
export function startOfDay(ts: number, tz: string | undefined): number {
  if (!tz) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  try {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts).split("-").map(Number) as [number, number, number];
    const utc = Date.UTC(y, m - 1, d);
    const guess = utc - zoneOffset(utc, tz);
    return utc - zoneOffset(guess, tz);
  } catch {
    return startOfDay(ts, undefined);
  }
}

/** The viewer's local midnight today; moves on at midnight. */
export function useDayStart(): number {
  const { timeZone } = usePrefs();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const day = startOfDay(now, timeZone);
  return day;
}

/** "under a minute", "4 min", "1 h 12 min". */
export function spanWords(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
