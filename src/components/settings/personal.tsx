"use client";
import * as React from "react";
import Link from "next/link";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Drag } from "iconoir-react";
import { SEARCH_ENGINES, type Prefs } from "@/lib/prefs";
import { NAV, orderedNav } from "@/lib/nav";
import { formatBytes, formatDate, formatRate, formatTemp, formatTime } from "@/lib/format";
import { usePrefs } from "@/components/PrefsProvider";
import { Panel, Kbd, UsageBar } from "@/components/ui/Surface";
import { Field, Input, Switch, SettingRow, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Button, LinkButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import s from "./settings.module.css";

function useSet() {
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
                  <i />
                  <i>
                    <b />
                    <b style={{ height: "40%" }} />
                    <b />
                    <b data-a="" />
                    <b style={{ height: "55%" }} />
                  </i>
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

// ---------------------------------------------------------------- navigation

function SortRow({ id, label, hint, hidden, locked, onToggle }: { id: string; label: string; hint: string; hidden: boolean; locked: boolean; onToggle: (v: boolean) => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <li ref={setNodeRef} className={s.sortItem} data-dragging={isDragging ? "" : undefined} data-hidden={hidden ? "" : undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button type="button" className={s.grip} {...attributes} {...listeners} aria-label={`Move ${label}`}>
        <Drag />
      </button>
      <span className={s.sortLabel}>
        {label}
        <small>{hint}</small>
      </span>
      <Switch checked={!hidden} onChange={onToggle} disabled={locked} aria-label={`Show ${label} in the sidebar`} />
    </li>
  );
}

export function Navigation() {
  const { prefs, viewer } = usePrefs();
  const set = useSet();
  const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, { memberStatus: true, memberFiles: true }).all;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const dndId = React.useId();
  const label = (id: string | number) => nav.find((n) => n.id === String(id))?.label ?? "Page";
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = nav.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    void set({ sidebarOrder: next });
  };
  return (
    <div className={s.stack}>
      <Panel
        title="Sidebar"
        flush
        meta={
          prefs.sidebarOrder.length || prefs.sidebarHidden.length ? (
            <Button size="sm" variant="ghost" onClick={() => void set({ sidebarOrder: [], sidebarHidden: [] })}>
              Back to the usual order
            </Button>
          ) : undefined
        }
      >
        <div style={{ padding: "12px 16px 16px" }}>
          <p className={s.hint} style={{ marginBottom: 12 }}>
            Drag the handle to reorder, or focus it and use Space and the arrow keys. Switch off what you don't use; it stays reachable with <Kbd>⌘K</Kbd>. Changes
            show in the sidebar straight away.
          </p>
          <DndContext
            id={dndId}
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onEnd}
            accessibility={{
              screenReaderInstructions: { draggable: "To move a page, press Space, use the up and down arrow keys, then press Space again to drop it, or Escape to cancel." },
              announcements: {
                onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
                onDragOver: ({ active, over }) => (over ? `${label(active.id)} is now at position ${nav.findIndex((n) => n.id === over.id) + 1} of ${nav.length}.` : undefined),
                onDragEnd: ({ active, over }) => (over ? `Dropped ${label(active.id)} at position ${nav.findIndex((n) => n.id === over.id) + 1}.` : `Dropped ${label(active.id)}.`),
                onDragCancel: ({ active }) => `Cancelled. ${label(active.id)} is back where it was.`,
              },
            }}
          >
            <SortableContext items={nav.map((n) => n.id)} strategy={verticalListSortingStrategy}>
              <ul className={s.sortList} role="list">
                {nav.map((n) => (
                  <SortRow
                    key={n.id}
                    id={n.id}
                    label={n.label}
                    hint={n.id === "home" ? "Always shown" : n.hint}
                    hidden={prefs.sidebarHidden.includes(n.id)}
                    locked={n.id === "home"}
                    onToggle={(v) => void set({ sidebarHidden: v ? prefs.sidebarHidden.filter((x) => x !== n.id) : [...prefs.sidebarHidden, n.id] })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      </Panel>
      <Panel title="Keyboard">
        <SettingRow label="Single-key shortcuts" description="Letters and / as shortcuts when you're not typing. ⌘K always works.">
          <Switch checked={prefs.shortcuts} onChange={(v) => void set({ shortcuts: v })} aria-label="Single-key shortcuts" />
        </SettingRow>
        <dl className={s.keys} style={{ marginTop: 12 }}>
          <dt>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </dt>
          <dd>Search and jump anywhere</dd>
          <dt>
            <Kbd>/</Kbd>
          </dt>
          <dd>Search (on Home: the web search box)</dd>
          {NAV.filter((n) => !n.admin || viewer.role === "admin")
            .slice(0, 9)
            .map((n) => {
              const key = { home: "h", status: "s", apps: "a", files: "f", network: "n", storage: "d", system: "y", diagnostics: "x", alerts: "l", people: "p" }[n.id];
              if (!key) return null;
              return (
                <React.Fragment key={n.id}>
                  <dt>
                    <Kbd>g</Kbd>
                    <Kbd>{key}</Kbd>
                  </dt>
                  <dd>Go to {n.label}</dd>
                </React.Fragment>
              );
            })}
        </dl>
      </Panel>
      <p className={s.hint}>
        Collapse the sidebar to icons with the button next to the server's name. <Link href="/settings/home">Home page settings</Link>
      </p>
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
            options={[{ value: "auto", label: "This device's time zone" }, ...tzs.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))]}
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
