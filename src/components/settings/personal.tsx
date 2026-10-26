"use client";
import * as React from "react";
import { SEARCH_ENGINES, type Prefs } from "@/lib/prefs";
import { formatBytes, formatDate, formatRate, formatTemp, formatTime } from "@/lib/format";
import { usePrefs } from "@/components/PrefsProvider";
import { Panel, UsageBar } from "@/components/ui/Surface";
import { Field, Input, Switch, SettingRow, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Button, LinkButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import s from "./settings.module.css";

export function useSet() {
  const { setPrefs } = usePrefs();
  return React.useCallback(
    (patch: Partial<Prefs>) =>
      setPrefs(patch).catch((e: unknown) => {
        toast.error("Couldn't save that", { description: e instanceof Error ? e.message : undefined });
      }),
    [setPrefs],
  );
}

// ---------------------------------------------------------------- appearance

const ATTENTION: { value: Prefs["attention"]; label: string; light: string; dark: string }[] = [
  { value: "sodium", label: "Sodium", light: "#d49b12", dark: "#f2c14e" },
  { value: "orange", label: "Orange", light: "#e0691a", dark: "#ff9a4d" },
  { value: "magenta", label: "Magenta", light: "#c23d8a", dark: "#f07abf" },
  { value: "cyan", label: "Cyan", light: "#1788a3", dark: "#5cc8e0" },
];

function useMedia(query: string) {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    setOn(mq.matches);
    const h = () => setOn(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return on;
}

const PLATES = {
  light: { ground: "#f4f3ef", panel: "#fdfcfa", line: "#dddbd4", ink: "#18181a", faint: "#c7c4bb" },
  dark: { ground: "#111214", panel: "#17181b", line: "#2c2d31", ink: "#ece7db", faint: "#4a4a4f" },
};

/** The theme cards draw Gluon itself in miniature: sidebar, a page title, a panel with one thing that needs you. */
function MiniPlate({ p }: { p: (typeof PLATES)["light"] }) {
  return (
    <g>
      <rect width="120" height="74" fill={p.ground} />
      <path d="M31.5 0V74" stroke={p.line} />
      <circle cx="8" cy="10" r="1.6" fill={p.ink} />
      <path d="M9.6 10q2.2-4 3.2-1.2 1 2.8 3.2-.2 2.2-3 3.2-.2" stroke={p.ink} strokeWidth="1" fill="none" strokeLinecap="round" />
      <rect x="5" y="20" width="22" height="6" rx="2" fill={p.panel} stroke={p.line} strokeWidth="0.6" />
      <path d="M7 32h14M7 39h17M7 46h11" stroke={p.faint} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M39 12h34" stroke={p.ink} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M39 19h52" stroke={p.faint} strokeWidth="1.4" strokeLinecap="round" />
      <rect x="38.5" y="27.5" width="75" height="40" rx="4" fill={p.panel} stroke={p.line} />
      <path d="M45 35v8M48 35v8" stroke="var(--swatch, var(--attn))" strokeWidth="1.6" />
      <path d="M53 37h34M53 42h22" stroke={p.ink} strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
      <path d="M38.5 50.5h75" stroke={p.line} />
      <path d="M46.5 55v8" stroke={p.ink} strokeWidth="1.6" />
      <path d="M53 57h28M53 62h16" stroke={p.faint} strokeWidth="1.4" strokeLinecap="round" />
    </g>
  );
}

function MiniApp({ mode }: { mode: "system" | "light" | "dark" }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 120 74" preserveAspectRatio="xMinYMid slice" width="100%" height="100%">
      {mode === "system" ? (
        <>
          <defs>
            <clipPath id={id}>
              <path d="M120 0V74H0z" />
            </clipPath>
          </defs>
          <MiniPlate p={PLATES.light} />
          <g clipPath={`url(#${id})`}>
            <MiniPlate p={PLATES.dark} />
          </g>
        </>
      ) : (
        <MiniPlate p={PLATES[mode]} />
      )}
    </svg>
  );
}

export function Appearance() {
  const { prefs } = usePrefs();
  const set = useSet();
  const sysDark = useMedia("(prefers-color-scheme: dark)");
  const sysCalm = useMedia("(prefers-reduced-motion: reduce)");
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && sysDark);
  return (
    <div className={s.appearance}>
      <div className={s.stack}>
        <Panel title="Theme">
          <div className={s.choiceGrid} role="group" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((m) => (
              <button key={m} type="button" className={s.choice} aria-pressed={prefs.theme === m} onClick={() => void set({ theme: m })}>
                <span className={s.mini} data-mode={m} aria-hidden>
                  <MiniApp mode={m} />
                </span>
                <span className={s.choiceText}>
                  {m === "system" ? "Match my device" : m === "light" ? "Light" : "Dark"}
                  <small suppressHydrationWarning>{m === "system" ? (sysDark ? "Dark right now" : "Light right now") : m === "light" ? "Bone plate, dark ink" : "Graphite, lamp-lit ink"}</small>
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Colour for “needs you”">
          <p className={s.hint} style={{ marginBottom: 14 }}>
            The one colour Gluon keeps for things you have to act on. Pick whichever you see most clearly; the doubled line means the same whatever its colour.
          </p>
          <div className={s.swatches} role="group" aria-label="Colour for things that need you">
            {ATTENTION.map((a) => (
              <button key={a.value} type="button" className={s.swatch} aria-pressed={prefs.attention === a.value} onClick={() => void set({ attention: a.value })}>
                <span className={s.swatchLines} aria-hidden>
                  <i style={{ background: dark ? a.dark : a.light }} />
                  <i style={{ background: dark ? a.dark : a.light }} />
                </span>
                {a.label}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Reading">
          <SettingRow label="Text size" description="Scales everything, not just text.">
            <Segmented
              aria-label="Text size"
              value={prefs.textSize}
              onChange={(v) => void set({ textSize: v })}
              options={[
                { value: "small", label: "Smaller" },
                { value: "default", label: "Default" },
                { value: "large", label: "Larger" },
              ]}
            />
          </SettingRow>
          <SettingRow label="Density" description="Compact fits more rows on screen.">
            <Segmented
              aria-label="Density"
              value={prefs.density}
              onChange={(v) => void set({ density: v })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </SettingRow>
          <SettingRow label="More contrast" description="Darker secondary text and stronger lines.">
            <Switch checked={prefs.contrast === "more"} onChange={(v) => void set({ contrast: v ? "more" : "standard" })} aria-label="More contrast" />
          </SettingRow>
          <SettingRow
            label="Reduce motion"
            description={
              sysCalm && prefs.motion !== "reduce"
                ? "Your device already asks for less motion, so Gluon keeps movement to a minimum."
                : "Things change in place instead of sliding. Gluon also follows your device's setting."
            }
          >
            <Switch checked={prefs.motion === "reduce"} onChange={(v) => void set({ motion: v ? "reduce" : "system" })} aria-label="Reduce motion" />
          </SettingRow>
        </Panel>
      </div>
      <PreviewPlate />
    </div>
  );
}

/**
 * A small plate drawn with the live tokens, so every choice above shows up here as you make it:
 * theme, the "needs you" colour, text size, density, contrast. "Try a fix" plays the one bit of
 * motion Gluon has everywhere: a doubled line settling into a single one.
 */
function PreviewPlate() {
  const [fixed, setFixed] = React.useState(false);
  return (
    <aside className={s.previewCol} aria-label="Preview">
      <div className={s.plate}>
        <div className={s.plateHead}>
          <span className="label">Preview</span>
          <span className={s.plateMeta}>Changes as you choose</span>
        </div>
        <div className={s.plateBody}>
          <p className={s.plateTitle}>Status</p>
          <p className={s.plateSummary}>
            <b>{fixed ? "Nothing needs you." : "One thing needs you."}</b> Everything else is running.
          </p>
          <ul className={s.plateRows} role="list">
            <li data-fixed={fixed ? "" : undefined} className={s.plateAttn}>
              <span className={s.plateMark} aria-hidden data-motion-gentle="" />
              <span className={s.plateText}>
                <b>{fixed ? "Fixed" : "Needs you"}</b>
                <small>{fixed ? "The doubled line settled into one" : "Doubled line, with the fix beside it"}</small>
              </span>
              <Button size="sm" onClick={() => setFixed((f) => !f)}>
                {fixed ? "Undo" : "Try a fix"}
              </Button>
            </li>
            <li>
              <StateLine state="running" />
              <span className={s.plateText}>
                <b>Running</b>
                <small>Solid line</small>
              </span>
            </li>
            <li className={s.plateExtra}>
              <StateLine state="starting" />
              <span className={s.plateText}>
                <b>Starting</b>
                <small>Dashed line</small>
              </span>
            </li>
            <li>
              <StateLine state="unhealthy" />
              <span className={s.plateText}>
                <b>Broken</b>
                <small>Short red line</small>
              </span>
            </li>
            <li className={s.plateExtra}>
              <StateLine state="stopped" />
              <span className={s.plateText}>
                <b>Stopped</b>
                <small>Faint line</small>
              </span>
            </li>
          </ul>
          <div className={`${s.plateMeter} ${s.plateExtra}`}>
            <span className="label">Space used</span>
            <UsageBar value={82} attention={80} label="Example of a nearly full disk" />
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- home page

export function HomePrefs() {
  const { prefs, viewer } = usePrefs();
  const set = useSet();
  const [custom, setCustom] = React.useState(prefs.searchCustomUrl);
  const [name, setName] = React.useState(prefs.greetingName);
  const customValid = /^https?:\/\/\S+%s/.test(custom);
  return (
    <div className={s.stack}>
      <Panel title="Your home page">
        <SettingRow label="Widgets" description="Add, move, resize and remove widgets right on the page.">
          <LinkButton href="/?edit=1">Customise home page</LinkButton>
        </SettingRow>
        <SettingRow label="Greeting" description={`“Good morning, ${prefs.greetingName || viewer.displayName.split(" ")[0]}.” at the top of the page.`}>
          <Switch checked={prefs.greeting} onChange={(v) => void set({ greeting: v })} aria-label="Greeting" />
        </SettingRow>
        {prefs.greeting && (
          <SettingRow stack label="Call me" description="Leave empty to use your first name.">
            <Input value={name} placeholder={viewer.displayName.split(" ")[0]} onChange={(e) => setName(e.target.value)} onBlur={() => name !== prefs.greetingName && void set({ greetingName: name.trim() })} maxLength={40} aria-label="Call me" />
          </SettingRow>
        )}
        <SettingRow label="Page width">
          <Segmented
            aria-label="Page width"
            value={prefs.homeWidth}
            onChange={(v) => void set({ homeWidth: v })}
            options={[
              { value: "comfortable", label: "Narrow" },
              { value: "wide", label: "Wide" },
              { value: "full", label: "Full" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Open Gluon on" description="Where you land after signing in or opening the installed app.">
          <Select
            aria-label="Open Gluon on"
            value={prefs.startPage}
            onChange={(v) => void set({ startPage: v })}
            options={[
              { value: "home", label: "Home" },
              { value: "status", label: "Status" },
              ...(viewer.role === "admin" ? [{ value: "apps" as const, label: "Apps" }] : []),
              { value: "files", label: "Files" },
            ]}
          />
        </SettingRow>
      </Panel>

      <Panel title="Search and links">
        <SettingRow label="Search with" description="Used by the search box on your home page.">
          <Select
            aria-label="Search engine"
            value={prefs.searchEngine}
            onChange={(v) => void set({ searchEngine: v })}
            options={[...Object.entries(SEARCH_ENGINES).map(([k, v]) => ({ value: k as Prefs["searchEngine"], label: v.name })), { value: "custom", label: "Something else…" }]}
          />
        </SettingRow>
        {prefs.searchEngine === "custom" && (
          <Field label="Search address" description="Put %s where your search goes, e.g. https://search.example.com/?q=%s" error={custom && !customValid ? "Include %s and start with https://" : null}>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => customValid && custom !== prefs.searchCustomUrl && void set({ searchCustomUrl: custom })} mono inputMode="url" />
          </Field>
        )}
        <SettingRow label="Open apps and links in a new tab">
          <Switch checked={prefs.openLinks === "new"} onChange={(v) => void set({ openLinks: v ? "new" : "same" })} aria-label="Open apps and links in a new tab" />
        </SettingRow>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- formats

export function Formats() {
  const { prefs, timeZone } = usePrefs();
  const set = useSet();
  // A live clock: the examples show exactly what the rest of Gluon will.
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const tzs = React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);
  // Built once: the clock above re-renders this page every second, and Select memoizes on `options`.
  const tzOptions = React.useMemo(() => [{ value: "auto", label: "This device's time zone" }, ...tzs.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))], [tzs]);
  const eff = { ...prefs, timezone: timeZone ?? "UTC" };
  return (
    <div className={s.stack}>
      <div className={s.specimen} aria-live="off">
        <span className={s.specimenTime}>
          <span className="num">{now === null ? "\u00a0" : formatTime(now, eff, true)}</span>
        </span>
        <span className={s.specimenLine}>
          <span className="num">{now === null ? "\u00a0" : formatDate(now, eff, { weekday: true, year: true })}</span>
          <span className={s.specimenUnits}>
            <span className="num">{formatBytes(2e12, prefs.bytes)}</span>
            <span className="num">{formatRate(12_500_000, prefs.rates)}</span>
            <span className="num">{formatTemp(62, prefs.temperature)}</span>
          </span>
        </span>
      </div>
      <Panel title="Time and date">
        <SettingRow label="Clock" description="Automatic follows your device's language.">
          <Segmented
            aria-label="Clock"
            value={prefs.clock}
            onChange={(v) => void set({ clock: v })}
            options={[
              { value: "auto", label: "Automatic" },
              { value: "12", label: "12-hour" },
              { value: "24", label: "24-hour" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Dates" description={now === null ? undefined : <span className={s.preview}>Today is <b>{formatDate(now, eff, { year: true })}</b></span>}>
          <Select
            aria-label="Date format"
            value={prefs.dateOrder}
            onChange={(v) => void set({ dateOrder: v })}
            options={[
              { value: "auto", label: "Automatic" },
              { value: "dmy", label: "Day month year" },
              { value: "mdy", label: "Month day year" },
              { value: "ymd", label: "Year-month-day" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Time zone" description={prefs.timezone === "auto" ? `Following this device: ${(timeZone ?? "unknown").replace(/_/g, " ")}` : "Times everywhere in Gluon are shown in this zone."}>
          <Select
            aria-label="Time zone"
            value={prefs.timezone}
            onChange={(v) => void set({ timezone: v })}
            options={tzOptions}
          />
        </SettingRow>
      </Panel>
      <Panel title="Units">
        <SettingRow label="File sizes" description={<span className={s.preview}>A 2 TB disk shows as <b>{formatBytes(2e12, prefs.bytes)}</b></span>}>
          <Segmented
            aria-label="File sizes"
            value={prefs.bytes}
            onChange={(v) => void set({ bytes: v })}
            options={[
              { value: "decimal", label: "GB (like disk makers)" },
              { value: "binary", label: "GiB (like Linux)" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Network speeds" description={<span className={s.preview}>100 megabit internet: <b>{formatRate(12_500_000, prefs.rates)}</b></span>}>
          <Segmented
            aria-label="Network speeds"
            value={prefs.rates}
            onChange={(v) => void set({ rates: v })}
            options={[
              { value: "bytes", label: "MB/s" },
              { value: "bits", label: "Mb/s" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Temperature" description={<span className={s.preview}>A warm processor: <b>{formatTemp(62, prefs.temperature)}</b></span>}>
          <Segmented
            aria-label="Temperature"
            value={prefs.temperature}
            onChange={(v) => void set({ temperature: v })}
            options={[
              { value: "c", label: "°C" },
              { value: "f", label: "°F" },
            ]}
          />
        </SettingRow>
      </Panel>
    </div>
  );
}
