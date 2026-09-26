"use client";
import * as React from "react";
import type { MonitorConfig, MonitorKind, MonitorView } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/Toast";
import s from "./alerts.module.css";

const INTERVALS = [
  { value: "30", label: "Every 30 seconds" },
  { value: "60", label: "Every minute" },
  { value: "120", label: "Every 2 minutes" },
  { value: "300", label: "Every 5 minutes" },
  { value: "600", label: "Every 10 minutes" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "3600", label: "Every hour" },
] as const;
const TIMEOUTS = ["3", "5", "10", "20", "30"].map((v) => ({ value: v, label: `${v} seconds` }));
const FAILS = ["1", "2", "3", "5", "10"].map((v) => ({ value: v, label: v === "1" ? "The first failed check" : `${v} failed checks in a row` }));

const ADVANCED = ["config.keyword", "config.expectStatus", "config.method", "config.severity", "config.app"];

interface Draft {
  name: string;
  kind: MonitorKind;
  target: string;
  interval: string;
  timeout: string;
  failAfter: string;
  method: "GET" | "HEAD";
  statusMin: string;
  statusMax: string;
  keyword: string;
  keywordAbsent: boolean;
  followRedirects: boolean;
  ignoreTls: boolean;
  severity: "fault" | "attention";
  app: string;
}

function draftFrom(m: MonitorView | null): Draft {
  const c: Partial<MonitorConfig> = m?.config ?? {};
  const interval = String(c.intervalSec ?? 60);
  return {
    name: m?.name ?? "",
    kind: m?.kind ?? "http",
    target: m?.target ?? "",
    interval: INTERVALS.some((i) => i.value === interval) ? interval : "60",
    timeout: String(c.timeoutSec ?? 10),
    failAfter: String(c.failAfter ?? 3),
    method: c.method ?? "GET",
    statusMin: String(c.expectStatus?.min ?? 200),
    statusMax: String(c.expectStatus?.max ?? 399),
    keyword: c.keyword ?? "",
    keywordAbsent: c.keywordAbsent ?? false,
    followRedirects: c.followRedirects ?? true,
    ignoreTls: c.ignoreTls ?? false,
    severity: c.severity ?? "attention",
    app: c.app ?? "",
  };
}

/** Add or edit a monitor. Automatic monitors only expose timing (the rest follows their app or address). */
interface AppChoice {
  id: string;
  name: string;
  self?: boolean;
  household?: boolean;
  urls?: { home: string | null; away: string | null };
}
type Source = "app" | "web" | "port";

/** Add or edit a monitor. New ones start from an app (address filled in), a web address, or a device's port. */
export function MonitorForm({
  open,
  onOpenChange,
  monitor,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  monitor: MonitorView | null;
  /** Current monitors, to say which apps are already watched. */
  existing?: MonitorView[];
  onSaved: (m: MonitorView) => void;
}) {
  const [d, setD] = React.useState<Draft>(() => draftFrom(monitor));
  const [source, setSource] = React.useState<Source>("app");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);
  const [advanced, setAdvanced] = React.useState(false);
  const auto = monitor?.source === "auto";
  const { data: appsRaw } = useApi<AppChoice[]>(open && !auto ? "/api/apps" : null);
  const apps = React.useMemo(() => (appsRaw ?? []).filter((a) => !a.self).sort((a, b) => a.name.localeCompare(b.name)), [appsRaw]);
  const autoName = React.useRef("");

  React.useEffect(() => {
    if (open) {
      setD(draftFrom(monitor));
      setSource(monitor ? (monitor.kind === "tcp" ? "port" : monitor.config.app ? "app" : "web") : "app");
      autoName.current = "";
      setErr(null);
      setAdvanced(false);
    }
  }, [open, monitor]);

  /** Picking an app fills in its name, its address (public if it has one) and links alerts to it. */
  function pickApp(id: string) {
    const a = apps.find((x) => x.id === id);
    setD((x) => {
      const name = !x.name.trim() || x.name === autoName.current ? (a?.name ?? "") : x.name;
      autoName.current = a?.name ?? "";
      const url = a?.urls?.away ?? a?.urls?.home ?? "";
      return { ...x, app: id, name, kind: "http", target: url || x.target, severity: a?.household ? "fault" : x.severity };
    });
  }
  function pickSource(v: Source) {
    setSource(v);
    setD((x) => ({ ...x, kind: v === "port" ? "tcp" : "http", app: v === "app" ? x.app : "" }));
  }
  /** A typed address suggests a name when there isn't one yet. */
  function suggestName() {
    if (d.name.trim()) return;
    const host = d.kind === "http" ? (() => { try { return new URL(d.target.trim()).hostname; } catch { return ""; } })() : d.target.split(":")[0];
    if (host) {
      autoName.current = host;
      set("name", host);
    }
  }
  const watchedBy = d.app ? (existing ?? []).filter((m) => m.config.app === d.app && m.id !== monitor?.id) : [];

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const fieldErr = (...keys: string[]) => (err?.field && keys.includes(err.field) ? err.message : null);

  async function save() {
    setBusy(true);
    setErr(null);
    const timing = { intervalSec: Number(d.interval), timeoutSec: Number(d.timeout), failAfter: Number(d.failAfter) };
    const config = auto
      ? timing
      : {
          ...timing,
          method: d.method,
          expectStatus: { min: Number(d.statusMin) || 200, max: Number(d.statusMax) || 399 },
          keyword: d.keyword.trim() || null,
          keywordAbsent: d.keywordAbsent,
          followRedirects: d.followRedirects,
          ignoreTls: d.ignoreTls,
          severity: d.severity,
          app: d.app || null,
        };
    try {
      const saved = monitor
        ? await api.patch<MonitorView>(`/api/alerts/monitors/${encodeURIComponent(monitor.id)}`, auto ? { config } : { name: d.name, kind: d.kind, target: d.target.trim(), config })
        : await api.post<MonitorView>("/api/alerts/monitors", { name: d.name, kind: d.kind, target: d.target.trim(), config, enabled: true });
      toast.success(monitor ? "Monitor saved" : `Watching ${saved.name}`, { description: monitor ? undefined : "The first check runs within a few seconds." });
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      const field = e instanceof ApiError ? e.field : undefined;
      if (field && ADVANCED.some((f) => field.startsWith(f))) setAdvanced(true);
      setErr({ message: e instanceof Error ? e.message : "Couldn't save it.", field });
    } finally {
      setBusy(false);
    }
  }

  const appOptions = [{ value: "", label: "No app" }, ...(apps ?? []).map((a) => ({ value: a.id, label: a.name }))];
  const known = ["name", "target", "config.intervalSec", "config.failAfter", "config.timeoutSec", "config.keyword", "config.expectStatus", "config.expectStatus.min", "config.expectStatus.max"];
  const shownErr = err && (!err.field || !known.includes(err.field)) ? err.message : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={monitor ? (auto ? `Timing for ${monitor.name}` : `Edit ${monitor.name}`) : "Add a monitor"}
      description={
        auto
          ? "This monitor follows its app or public address automatically. You can change how often it checks and when it counts as down."
          : monitor
            ? undefined
            : "Gluon checks the address on a schedule and tells you when it stops answering."
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {monitor ? "Save" : "Start watching"}
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!auto && (
          <>
            {!monitor && (
              <Field label="What to watch">
                <Segmented
                  aria-label="What to watch"
                  value={source}
                  onChange={pickSource}
                  options={[
                    { value: "app", label: "One of my apps" },
                    { value: "web", label: "A web address" },
                    { value: "port", label: "A device's port" },
                  ]}
                />
              </Field>
            )}
            {source === "app" && !monitor && (
              <Field
                label="App"
                description={
                  watchedBy.length
                    ? `Gluon already checks this app ${watchedBy.map((m) => (m.ref?.startsWith("route:") ? "from the internet" : m.source === "auto" ? "on the home network" : `at ${m.target.replace(/^https?:\/\//, "")}`)).join(" and ")}. Add another to check a particular page, like /health.`
                    : "Its address is filled in for you. Alerts about it reach the household members who use it."
                }
              >
                <Select
                  aria-label="App"
                  value={d.app}
                  onChange={pickApp}
                  placeholder={appsRaw ? "Choose an app" : "Loading apps…"}
                  options={apps.map((a) => ({ value: a.id, label: a.name }))}
                />
              </Field>
            )}
            <Field
              label={d.kind === "http" ? "Address" : "Host and port"}
              error={fieldErr("target")}
              description={d.kind === "http" ? "The full address, including http:// or https://. Add a path to check one page." : "Checks that something accepts connections, e.g. a NAS on 192.168.1.20:445."}
            >
              <Input
                mono
                value={d.target}
                onChange={(e) => set("target", e.target.value)}
                onBlur={suggestName}
                placeholder={d.kind === "http" ? "https://example.com/health" : "192.168.1.20:22"}
                spellCheck={false}
                autoCapitalize="off"
                inputMode="url"
              />
            </Field>
            <Field label="Name" error={fieldErr("name")} description={source === "app" && !monitor ? "How it's listed. Change it if you watch more than one page." : undefined}>
              <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder={d.kind === "http" ? "e.g. Router admin page" : "e.g. NAS file sharing"} maxLength={80} />
            </Field>
            {monitor && (
              <Field label="Kind of check">
                <Segmented
                  aria-label="Kind of check"
                  value={d.kind}
                  onChange={(v) => set("kind", v)}
                  options={[
                    { value: "http", label: "Web page" },
                    { value: "tcp", label: "Port" },
                  ]}
                />
              </Field>
            )}
          </>
        )}
        <div className={s.row2}>
          <Field label="How often" error={fieldErr("config.intervalSec")}>
            <Select aria-label="How often" value={d.interval} onChange={(v) => set("interval", v)} options={INTERVALS} />
          </Field>
          <Field label="Counts as down after" error={fieldErr("config.failAfter")}>
            <Select aria-label="Counts as down after" value={d.failAfter} onChange={(v) => set("failAfter", v)} options={FAILS} />
          </Field>
        </div>
        <Field label="Give up waiting after" error={fieldErr("config.timeoutSec")} description="Must be shorter than the time between checks.">
          <Select aria-label="Timeout" value={d.timeout} onChange={(v) => set("timeout", v)} options={TIMEOUTS} />
        </Field>

        {!auto && (
          <Disclosure summary="More options" open={advanced} onOpenChange={setAdvanced} variant="panel">
            <div className={s.disclosureBody}>
              <Field label="When it's down, it's" description="Broken things can wake you up during quiet hours if you allow it.">
                <Segmented
                  aria-label="Severity"
                  value={d.severity}
                  onChange={(v) => set("severity", v)}
                  options={[
                    { value: "attention", label: "Needs attention" },
                    { value: "fault", label: "Broken" },
                  ]}
                />
              </Field>
              <Field label="Belongs to app" optional description="Links the alert to the app, so household members who use it are told too.">
                <Select aria-label="Belongs to app" value={d.app} onChange={(v) => set("app", v)} options={appOptions} />
              </Field>
              {d.kind === "http" && (
                <>
                  <div className={s.row3}>
                    <Field label="Request">
                      <Segmented
                        aria-label="Request method"
                        value={d.method}
                        onChange={(v) => set("method", v)}
                        options={[
                          { value: "GET", label: "GET" },
                          { value: "HEAD", label: "HEAD" },
                        ]}
                      />
                    </Field>
                    <Field label="Lowest OK status" error={fieldErr("config.expectStatus", "config.expectStatus.min")}>
                      <Input className="num" inputMode="numeric" value={d.statusMin} onChange={(e) => set("statusMin", e.target.value.replace(/\D/g, "").slice(0, 3))} />
                    </Field>
                    <Field label="Highest OK status" error={fieldErr("config.expectStatus.max")}>
                      <Input className="num" inputMode="numeric" value={d.statusMax} onChange={(e) => set("statusMax", e.target.value.replace(/\D/g, "").slice(0, 3))} />
                    </Field>
                  </div>
                  <Field label="Text on the page" optional error={fieldErr("config.keyword")} description="Only counts as up when the page contains this text (first 1 MB).">
                    <Input value={d.keyword} onChange={(e) => set("keyword", e.target.value)} maxLength={200} placeholder="e.g. Welcome" />
                  </Field>
                  {d.keyword.trim() && (
                    <Checkbox checked={d.keywordAbsent} onChange={(v) => set("keywordAbsent", v)}>
                      Count as down when the text <b>is</b> there instead (e.g. “Maintenance”)
                    </Checkbox>
                  )}
                  <Checkbox checked={d.followRedirects} onChange={(v) => set("followRedirects", v)}>
                    Follow redirects
                  </Checkbox>
                  <Checkbox checked={d.ignoreTls} onChange={(v) => set("ignoreTls", v)}>
                    Accept self-signed or expired certificates (devices on the home network)
                  </Checkbox>
                </>
              )}
            </div>
          </Disclosure>
        )}
        {shownErr && (
          <p className={s.error} role="alert">
            {shownErr}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
