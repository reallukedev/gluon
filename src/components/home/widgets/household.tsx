"use client";
// Household widgets anyone can use: is the internet up, the guest Wi-Fi code, and photos from this day in past years.
import * as React from "react";
import { mutate as mutateGlobal } from "swr";
import { Eye, EyeClosed, NavArrowLeft, NavArrowRight } from "iconoir-react";
import { registerWidget } from "../widgetStore";
import type { SettingsProps, WidgetProps } from "../types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Checkbox, Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import type { GuestWifiData, GuestWifiInput, InternetData, WifiSecurity } from "@/lib/home-widgets-types";
import type { IntegrationRef } from "@/lib/widgets-types";
import { useSmartUrl } from "./core";
import { Gate, IntegrationPicker, Quiet, useIntegrationWidget } from "./live/shared";
import { TitleField, type IntegrationConfig } from "./live/media";
import { Age, SetUp, WidgetState, spanWords, useBox, useDayStart, useReducedMotion } from "./kit";
import { Preview } from "../previews";
import h from "./household.module.css";

// ================================================================ Internet

/** Worst first: what a bucket of minutes shows when they differ. */
const RANK: Record<string, number> = { r: 5, d: 4, l: 3, s: 2, o: 1, "-": 0 };
const CELL_WORDS: Record<string, string> = { o: "Up", s: "Slow", l: "Unsteady", d: "Down", r: "Down (router)", "-": "Not measured" };

function useInternet() {
  return useApi<InternetData>("/api/widgets/internet", { refresh: 30_000 });
}

/** The 24-hour strip in StateLine grammar: solid = answered, dashed = slow or unsteady, short red = down, faint = not measured. */
function Strip({ data, height, axis, onRead }: { data: InternetData; height: number; axis: boolean; onRead?: (label: string | null) => void }) {
  const fmt = useFormat();
  const [ref, box] = useBox<HTMLDivElement>();
  const [cursor, setCursor] = React.useState<number | null>(null);
  const cells = data.strip.cells;
  const n = Math.max(12, Math.min(cells.length, Math.floor(box.w / 4)));
  const per = Math.max(1, Math.ceil(cells.length / n));
  const buckets = React.useMemo(() => {
    const out: { c: string; from: number; to: number; ms: number | null }[] = [];
    for (let i = 0; i < cells.length; i += per) {
      let c = "-";
      let sum = 0;
      let k = 0;
      for (let j = i; j < Math.min(cells.length, i + per); j++) {
        const x = cells[j]!;
        if (RANK[x]! > RANK[c]!) c = x;
        const m = data.strip.ms[j];
        if (m !== null && m !== undefined) {
          sum += m;
          k++;
        }
      }
      out.push({ c, from: data.strip.start + i * data.strip.step, to: data.strip.start + Math.min(cells.length, i + per) * data.strip.step, ms: k ? sum / k : null });
    }
    return out;
  }, [cells, per, data.strip]);

  const read = (i: number | null) => {
    setCursor(i);
    if (!onRead) return;
    if (i === null) return onRead(null);
    const b = buckets[i];
    if (!b) return onRead(null);
    const when = `${fmt.time(b.from)}–${fmt.time(b.to)}`;
    onRead(`${when} · ${CELL_WORDS[b.c]}${b.ms !== null && (b.c === "o" || b.c === "s" || b.c === "l") ? ` · ${Math.round(b.ms)} ms` : ""}`);
  };
  const w = box.w;
  const step = buckets.length ? w / buckets.length : 0;
  const pick = (clientX: number, rect: DOMRect) => read(Math.max(0, Math.min(buckets.length - 1, Math.floor((clientX - rect.left) / Math.max(1, step)))));
  const down = buckets.filter((b) => b.c === "d" || b.c === "r").length;
  const label = `The last 24 hours of internet checks: ${down ? `${down} stretch${down === 1 ? "" : "es"} with the internet down` : "no outages"}. Use the arrow keys to read a moment.`;
  // Labels every 6 hours from the start of the strip; "Now" closes the row.
  const ticks = axis ? [0, 6, 12, 18].map((hours) => data.strip.start + hours * 3_600_000) : [];

  return (
    <div className={h.stripWrap}>
      <div className={h.strip} ref={ref} style={{ height }}>
        {w > 0 && (
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={label}
            tabIndex={onRead ? 0 : -1}
            className={h.stripSvg}
            onPointerMove={(e) => onRead && pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerDown={(e) => onRead && pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={(e) => e.pointerType === "mouse" && read(null)}
            onBlur={() => read(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const cur = cursor ?? buckets.length - 1;
                read(Math.max(0, Math.min(buckets.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1))));
              } else if (e.key === "Escape") read(null);
            }}
          >
            <line className={h.rail} x1={0} x2={w} y1={height - 0.5} y2={height - 0.5} />
            {buckets.map((b, i) => {
              const x = Math.round(i * step + step / 2) + 0.5;
              const bad = b.c === "d" || b.c === "r";
              const y1 = bad ? height - 1 - Math.round((height - 1) * 0.45) : 1;
              return <line key={b.from} x1={x} x2={x} y1={y1} y2={height - 1} className={h.tick} data-c={b.c} data-on={cursor === i ? "" : undefined} />;
            })}
          </svg>
        )}
      </div>
      {axis && (
        <div className={h.axis} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="num">
              {fmt.time(t).replace(/:00(?=\s|$)/, "")}
            </span>
          ))}
          <span>Now</span>
        </div>
      )}
    </div>
  );
}

function internetSentence(d: InternetData, dayStart: number, fmt: ReturnType<typeof useFormat>): string {
  const now = Date.now();
  const open = d.outages.find((o) => o.end === null);
  if (open) {
    const since = `${spanWords(now - open.start)}, since ${fmt.time(open.start)}`;
    return open.cause === "router"
      ? `Nothing on your home network has answered for ${since}. Check the router is on.`
      : `The internet has been down for ${since}. Your router answers, so the problem is beyond it.`;
  }
  const today = d.outages.filter((o) => (o.end ?? now) > dayStart);
  if (!today.length) {
    const measuredToday = d.since !== null && d.since <= dayStart;
    return measuredToday ? "No drops today." : "No drops since Gluon started watching.";
  }
  const longest = today.reduce((a, b) => ((b.end ?? now) - b.start > (a.end ?? now) - a.start ? b : a));
  const dur = spanWords((longest.end ?? now) - longest.start);
  const routerTimes = today.filter((o) => o.cause === "router").length;
  const lead =
    today.length === 1
      ? `Your internet dropped once today, for ${dur} at ${fmt.time(longest.start)}.`
      : `Your internet dropped ${today.length} times today, longest ${dur} at ${fmt.time(longest.start)}.`;
  const router = routerTimes ? (routerTimes === today.length ? (today.length === 1 ? " The router didn't answer either." : " Each time the router didn't answer either.") : ` ${routerTimes} of those, the router didn't answer either.`) : "";
  return lead + router;
}

function InternetWidget({ size }: WidgetProps) {
  const { data, error, mutate } = useInternet();
  const { viewer } = usePrefs();
  const fmt = useFormat();
  const dayStart = useDayStart();
  const [reading, setReading] = React.useState<string | null>(null);
  if (!data) {
    if (error) {
      return (
        <WidgetState
          line="unknown"
          title="Gluon isn't answering"
          action={
            <Button size="sm" variant="ghost" onClick={() => void mutate()}>
              Try again
            </Button>
          }
        >
          If other websites load, the internet is fine: it&apos;s the server, or the way to it.
        </WidgetState>
      );
    }
    return (
      <div className={h.net} data-size={size} aria-busy="true" aria-label="Checking the internet">
        <div className={h.netHead}>
          <Skeleton width={2} height={18} radius={0} />
          <Skeleton width="45%" height={16} />
        </div>
        <Skeleton width={72} height={26} />
        {size !== "s" && <Skeleton height={30} />}
      </div>
    );
  }
  const compact = size === "s";
  const measured = data.strip.cells.replace(/-/g, "").length;
  const heads: Record<InternetData["state"], { line: "running" | "starting" | "unhealthy"; words: string }> = {
    ok: { line: "running", words: "The internet is up" },
    slow: { line: "starting", words: "The internet is slow right now" },
    down: { line: "unhealthy", words: "The internet is down" },
    router: { line: "unhealthy", words: "The router isn't answering" },
    waiting: { line: "starting", words: "Checking the connection…" },
  };
  const head = heads[data.state];
  const stale = data.state !== "waiting" && data.checkedAt !== null && Date.now() - data.checkedAt > 3 * data.intervalMs;
  const tall = size === "t" || size === "l" || size === "x";
  const sentence = internetSentence(data, dayStart, fmt);
  return (
    <div className={h.net} data-size={size}>
      <div className={h.netHead}>
        <StateLine state={stale ? "unknown" : head.line} size={16} />
        <p className={h.netWords}>{stale ? "Not checked lately" : head.words}</p>
        {data.latencyMs !== null && <span className={`${h.headMs} num`}>{Math.round(data.latencyMs)} ms</span>}
        {stale && <Age at={data.checkedAt} expectMs={3 * data.intervalMs} />}
      </div>
      <div className={h.netFigures} aria-live="off">
        {data.latencyMs !== null ? (
          <span className={h.figure}>
            {data.latencyMs < 10 ? data.latencyMs.toFixed(1) : Math.round(data.latencyMs)}
            <small> ms</small>
          </span>
        ) : (
          <span className={h.figure} data-muted="">
            {data.state === "waiting" ? "…" : "No answer"}
          </span>
        )}
        {!compact && (
          <span className={h.reading}>
            {reading ?? (data.baselineMs !== null ? `Usually ${Math.round(data.baselineMs)} ms` : "Round trip to the internet")}
          </span>
        )}
      </div>
      {measured > 0 ? (
        <Strip data={data} height={compact ? 18 : tall ? 40 : 26} axis={!compact} onRead={compact ? undefined : setReading} />
      ) : (
        <p className={h.learning}>The last day fills in here as Gluon checks, every 30 seconds.</p>
      )}
      <p className={h.sentence}>{sentence}</p>
      {tall && (
        <p className={h.foot}>
          {data.loss24h !== null && data.loss24h > 0.0005 ? `${fmt.percent(data.loss24h * 100, 1)} of checks went unanswered in the last day. ` : ""}
          {viewer.role === "admin"
            ? `Checks ${data.targets.join(" and ")}${data.router ? ` and the router (${data.router})` : ""} every 30 seconds.`
            : "Gluon checks the connection every 30 seconds."}
        </p>
      )}
    </div>
  );
}

registerWidget({
  type: "household.internet",
  name: "Internet",
  description: "Is it the internet or the server? Latency now, the last 24 hours, and every time it dropped.",
  category: "Household",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  title: () => "Internet",
  Component: InternetWidget,
  preview: <Preview of="internet" />,
});

// ================================================================ Guest Wi-Fi

function useGuestWifi() {
  return useApi<GuestWifiData>("/api/widgets/guest-wifi", { refresh: 300_000 });
}

/** The code, drawn dark on light in both themes: some phone cameras can't read a light-on-dark code. */
function Qr({ size, bits, label }: { size: number; bits: string; label: string }) {
  const d = React.useMemo(() => {
    let p = "";
    for (let y = 0; y < size; y++) {
      let x = 0;
      while (x < size) {
        if (bits[y * size + x] === "1") {
          let run = 1;
          while (x + run < size && bits[y * size + x + run] === "1") run++;
          p += `M${x} ${y}h${run}v1h-${run}z`;
          x += run;
        } else x++;
      }
    }
    return p;
  }, [size, bits]);
  const q = 2;
  return (
    <svg className={h.qr} viewBox={`${-q} ${-q} ${size + q * 2} ${size + q * 2}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect className={h.qrPlate} x={-q} y={-q} width={size + q * 2} height={size + q * 2} rx={1.5} />
      <path className={h.qrDots} d={d} />
    </svg>
  );
}

const SECURITY_WORDS: Record<WifiSecurity, string> = { WPA: "WPA2 / WPA3", WEP: "WEP (old)", nopass: "Open, no password" };

interface WifiConfig {
  /** Unsaved changes to the network (admins, settings dialog only); never kept in the layout. */
  _wifi?: GuestWifiInput & { remove?: boolean };
}

function GuestWifiWidget({ size, openSettings }: WidgetProps<WifiConfig>) {
  const { data, error, mutate } = useGuestWifi();
  const { viewer } = usePrefs();
  const [show, setShow] = React.useState(false);
  if (!data) {
    if (error) {
      return (
        <WidgetState
          line="unknown"
          title="Can't show the guest network"
          action={
            <Button size="sm" variant="ghost" onClick={() => void mutate()}>
              Try again
            </Button>
          }
        >
          Gluon didn&apos;t answer just now.
        </WidgetState>
      );
    }
    return (
      <div className={h.wifi} data-size={size} aria-busy="true" aria-label="Loading the guest network">
        <Skeleton width={size === "s" ? 112 : 136} height={size === "s" ? 112 : 136} radius={8} />
        <div className={h.wifiText}>
          <Skeleton width="70%" height={16} />
          <Skeleton width="50%" height={12} />
        </div>
      </div>
    );
  }
  if (!data.configured) {
    return viewer.role === "admin" ? (
      <WidgetState title="Add your guest network" action={<SetUp openSettings={openSettings}>Set up guest Wi-Fi</SetUp>}>
        Enter it once and anyone at home can show guests a code to join.
      </WidgetState>
    ) : (
      <WidgetState title="Guest Wi-Fi isn't set up">Whoever runs the server can add it. Then this shows a code guests scan to join.</WidgetState>
    );
  }
  const secret = data.password;
  return (
    <div className={h.wifi} data-size={size}>
      <Qr size={data.qr.size} bits={data.qr.bits} label={`Code to join the Wi-Fi network ${data.ssid}. Point a phone's camera at it.`} />
      <div className={h.wifiText}>
        <span className="label">Guest Wi-Fi</span>
        <span className={h.ssid} title={data.ssid}>
          {data.ssid}
        </span>
        {data.security === "nopass" ? (
          <span className={h.wifiMeta}>No password needed</span>
        ) : secret ? (
          <span className={h.password}>
            <span className={`${h.secret} mono`} aria-label={show ? `Password: ${secret}` : "Password hidden"} title={show ? secret : undefined}>
              {show ? secret : "•".repeat(Math.min(12, Math.max(8, secret.length)))}
            </span>
            <IconButton label={show ? "Hide password" : "Show password"} size="sm" onClick={() => setShow((v) => !v)}>
              {show ? <EyeClosed /> : <Eye />}
            </IconButton>
            {size !== "s" && <CopyButton value={secret} label="Copy password" size="sm" />}
          </span>
        ) : (
          <span className={h.wifiMeta}>{viewer.role === "admin" ? "The password needs entering again." : "The password isn't available."}</span>
        )}
        {size !== "s" && (
          <span className={h.wifiMeta}>
            {data.hidden ? "Hidden network · " : ""}
            Point a phone&apos;s camera at the code to join.
          </span>
        )}
      </div>
    </div>
  );
}

function GuestWifiSettings({ config, onChange }: SettingsProps<WifiConfig>) {
  const { viewer } = usePrefs();
  const { data } = useGuestWifi();
  const [confirm, confirmNode] = useConfirm();
  const [removing, setRemoving] = React.useState(false);
  const saved = data?.configured ? data : null;
  const draft: GuestWifiInput = config._wifi ?? { ssid: saved?.ssid ?? "", security: saved?.security ?? "WPA", hidden: saved?.hidden ?? false };
  const set = (patch: Partial<GuestWifiInput>) => onChange({ ...config, _wifi: { ...draft, ...patch } });
  if (viewer.role !== "admin") {
    return <Notice title="Only admins can change the guest network">Ask whoever runs the server if the name or password has changed.</Notice>;
  }
  if (!data) return <Skeleton height={160} />;
  const needsPassword = draft.security !== "nopass" && (!saved || saved.security === "nopass" || !saved.password);
  return (
    <div className={h.form}>
      <Field label="Network name" description="Exactly as it appears in the Wi-Fi list.">
        <Input value={draft.ssid} maxLength={32} onChange={(e) => set({ ssid: e.target.value })} placeholder="Home Guest" autoComplete="off" />
      </Field>
      <Field label="Security">
        <Select
          aria-label="Security"
          value={draft.security}
          onChange={(v) => set({ security: v })}
          options={(["WPA", "WEP", "nopass"] as const).map((v) => ({ value: v, label: SECURITY_WORDS[v] }))}
        />
      </Field>
      {draft.security !== "nopass" && (
        <Field
          label="Password"
          description={needsPassword ? "Stored encrypted on this server. Everyone who can see Home can see it: that's the point." : "Leave empty to keep the saved password."}
        >
          <Input
            type="text"
            value={draft.password ?? ""}
            onChange={(e) => set({ password: e.target.value })}
            placeholder={needsPassword ? "At least 8 characters" : "••••••••"}
            autoComplete="off"
            spellCheck={false}
            mono
          />
        </Field>
      )}
      <Checkbox checked={draft.hidden} onChange={(v) => set({ hidden: v })}>
        The network is hidden (it doesn&apos;t show in the Wi-Fi list)
      </Checkbox>
      {saved && (
        <div>
          <Button
            variant="danger"
            size="sm"
            loading={removing}
            onClick={() =>
              confirm({
                title: "Remove the guest network?",
                consequences: ["Nobody can show the code from Home until it's added again.", "Your router isn't changed."],
                confirmLabel: "Remove",
                onConfirm: async () => {
                  setRemoving(true);
                  try {
                    await api.del("/api/widgets/guest-wifi");
                    await mutateGlobal("/api/widgets/guest-wifi");
                    onChange({});
                    toast.success("Removed the guest network");
                  } catch (e) {
                    toast.error("Couldn't remove it", { description: e instanceof ApiError ? e.message : undefined });
                  } finally {
                    setRemoving(false);
                  }
                },
              })
            }
          >
            Remove the network
          </Button>
        </div>
      )}
      {confirmNode}
    </div>
  );
}

registerWidget<WifiConfig>({
  type: "household.guest-wifi",
  name: "Guest Wi-Fi",
  description: "A code guests scan with their phone to join your Wi-Fi, plus the password if they'd rather type it.",
  category: "Household",
  sizes: ["s", "m"],
  defaultSize: "s",
  defaultConfig: {},
  Component: GuestWifiWidget,
  Settings: GuestWifiSettings,
  async beforeSave(config) {
    const { _wifi, ...rest } = config;
    if (!_wifi) return rest;
    const body: GuestWifiInput = { ssid: _wifi.ssid.trim(), security: _wifi.security, hidden: _wifi.hidden };
    if (_wifi.security !== "nopass" && _wifi.password) body.password = _wifi.password;
    await api.put("/api/widgets/guest-wifi", body);
    await mutateGlobal("/api/widgets/guest-wifi");
    toast.success("Saved the guest network");
    return rest;
  },
  preview: <Preview of="guest-wifi" />,
});

// ================================================================ On this day (Immich)

interface OnThisDayConfig extends IntegrationConfig {
  cycle?: boolean;
}

function immichHref(src: IntegrationRef | null, url: (u: IntegrationRef["links"]) => string | null, assetId: string): string | null {
  const base = src ? url(src.links) : null;
  return base ? `${base.replace(/\/+$/, "")}/photos/${encodeURIComponent(assetId)}` : null;
}

function OnThisDayWidget({ item, size }: WidgetProps<OnThisDayConfig>) {
  const q = useIntegrationWidget("immich", "immich.onThisDay", item.config.integration, {});
  const src = q.source.state === "ok" ? q.source.ref : null;
  const fmt = useFormat();
  const { viewer } = usePrefs();
  return (
    <Gate kind="immich" source={q.source} q={q} skeleton={<div className={h.photoSkel} aria-busy="true" aria-label="Loading photos" />}>
      {(d) => {
        const photos = d.years.flatMap((y) => y.photos.map((p) => ({ ...p, year: y.year, yearsAgo: y.yearsAgo })));
        if (!photos.length) {
          const today = fmt.date(Date.now()).replace(/,? \d{4}$/, "");
          return (
            <Quiet title={d.note && viewer.role === "admin" ? "Immich won't share memories" : "No photos from this day"}>
              {d.note && viewer.role === "admin" ? d.note : `Photos taken on ${today} in earlier years show up here.`}
            </Quiet>
          );
        }
        return <PhotoCycle photos={photos} src={src} size={size} cycle={item.config.cycle !== false} />;
      }}
    </Gate>
  );
}

function PhotoCycle({
  photos,
  src,
  size,
  cycle,
}: {
  photos: { id: string; image: string; kind: "image" | "video"; year: number; yearsAgo: number; takenAt: number | null }[];
  src: IntegrationRef | null;
  size: string;
  cycle: boolean;
}) {
  const [i, setI] = React.useState(0);
  const [held, setHeld] = React.useState(false);
  const reduced = useReducedMotion();
  const url = useSmartUrl();
  const { prefs } = usePrefs();
  const fmt = useFormat();
  const n = photos.length;
  const at = ((i % n) + n) % n;
  const p = photos[at]!;
  const next = photos[(at + 1) % n]!;
  // Step on by itself every 8 seconds, unless someone is looking closely (hover, focus) or asked for less motion.
  React.useEffect(() => {
    if (!cycle || held || reduced || n < 2) return;
    const t = setInterval(() => {
      if (!document.hidden) setI((x) => x + 1);
    }, 8000);
    return () => clearInterval(t);
  }, [cycle, held, reduced, n]);
  const href = immichHref(src, url, p.id);
  const img = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img key={p.id} src={p.image} alt={`Photo from ${p.year}${p.takenAt ? `, ${fmt.date(p.takenAt, { year: true })}` : ""}`} className={h.photo} decoding="async" />
      {n > 1 && (
        // Warm the next one so stepping doesn't flash.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={next.image} alt="" aria-hidden className={h.preload} decoding="async" loading="eager" />
      )}
    </>
  );
  return (
    <div
      className={h.memory}
      data-size={size}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {href ? (
        <a className={h.photoLink} href={href} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`Open this ${p.year} photo in Immich`}>
          {img}
        </a>
      ) : (
        <div className={h.photoLink}>{img}</div>
      )}
      <div className={h.plate}>
        <span className={h.year}>{p.year}</span>
        <span className={h.ago}>{p.yearsAgo === 1 ? "A year ago today" : `${p.yearsAgo} years ago today`}</span>
      </div>
      {n > 1 && (
        <div className={h.steps}>
          <IconButton label="Previous photo" size="sm" onClick={() => setI((x) => x - 1)}>
            <NavArrowLeft />
          </IconButton>
          <span className={`${h.count} num`} aria-live="polite">
            {at + 1} of {n}
          </span>
          <IconButton label="Next photo" size="sm" onClick={() => setI((x) => x + 1)}>
            <NavArrowRight />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function OnThisDaySettings({ config, onChange }: SettingsProps<OnThisDayConfig>) {
  return (
    <div className={h.form}>
      <IntegrationPicker kind="immich" value={config.integration} onChange={(integration) => onChange({ ...config, integration })} />
      <Checkbox checked={config.cycle !== false} onChange={(v) => onChange({ ...config, cycle: v })}>
        Move to the next photo every few seconds
      </Checkbox>
      <TitleField config={config} onChange={onChange} placeholder="On this day" />
    </div>
  );
}

registerWidget<OnThisDayConfig>({
  type: "immich.on-this-day",
  kind: "immich",
  name: "On this day",
  description: "Photos taken on today's date in earlier years, one at a time, large.",
  category: "Media & services",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "l",
  defaultConfig: {},
  title: (c) => c.title || null,
  label: () => "On this day",
  Component: OnThisDayWidget,
  Settings: OnThisDaySettings,
  preview: <Preview of="on-this-day" />,
});

export {};
