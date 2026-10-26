"use client";
import * as React from "react";
import { Plus, Trash } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Panel, Skeleton, Notice } from "@/components/ui/Surface";
import { AffixInput, Field, Input, Switch, SettingRow } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/Toast";
import { WorksWith } from "./WorksWith";
import s from "./settings.module.css";

interface ServerSettings {
  serverName: string;
  publicHost: string;
  baseDomain: string;
  homeNetworks: string[];
  detectedPrefixes: string[];
  mfaPolicy: MfaPolicy;
  passwordPolicy: { minLength: number; notUsername: boolean; lettersAndNumbers: boolean };
  sessionDays: number;
  awaySessionDays: number;
  householdCanSeeStatus: boolean;
  thresholds: { diskAttention: number; diskFault: number; tempAttention: number; certDays: number; memoryAttention: number };
}

type MfaPolicy = "off" | "admins-away" | "admins" | "everyone-away" | "everyone";

const MFA_OPTIONS: { value: MfaPolicy; label: string }[] = [
  { value: "admins-away", label: "Admins, away from home" },
  { value: "admins", label: "Admins, always" },
  { value: "everyone-away", label: "Everyone, away from home" },
  { value: "everyone", label: "Everyone, always" },
  { value: "off", label: "Nobody" },
];

const MFA_EXPLAIN: Record<MfaPolicy, string> = {
  "admins-away": "Admins need a code from their phone outside home. At home a password is enough.",
  admins: "Admins need a code every time. Anyone without it sets it up at their next sign-in at home.",
  "everyone-away": "Everyone needs a code outside home. At home a password is enough.",
  everyone: "Everyone needs a code every time. Anyone without it sets it up at their next sign-in at home.",
  off: "Nobody is asked for a code. Anyone can still turn it on for themselves.",
};

function DaysInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <AffixInput
      type="number"
      inputMode="numeric"
      min={1}
      max={90}
      value={value}
      onChange={(e) => onChange(Math.max(1, Math.min(90, Math.round(Number(e.target.value)) || 1)))}
      after="days"
      aria-label={label}
      style={{ width: 64 }}
    />
  );
}

function Threshold({ value, min, max, unit, label, onChange }: { value: number; min: number; max: number; unit: string; label: string; onChange: (v: number) => void }) {
  return (
    <AffixInput
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      after={unit}
      aria-label={label}
      className={s.unitInput}
    />
  );
}

export function Server() {
  const { data, mutate } = useApi<ServerSettings>("/api/settings/server");
  const { viewer } = usePrefs();
  const [f, setF] = React.useState<ServerSettings | null>(null);
  const [cidr, setCidr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const stackRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (data && !f) setF(data);
  }, [data, f]);
  if (!f || !data) {
    // Shaped like the panels that follow (works-with, this server, home network, signing in).
    return (
      <div className={s.stack} aria-busy="true">
        {[150, 150, 250, 380].map((h, i) => (
          <Skeleton key={i} height={h} radius={12} />
        ))}
      </div>
    );
  }

  const dirty = JSON.stringify({ ...f, detectedPrefixes: [] }) !== JSON.stringify({ ...data, detectedPrefixes: [] });
  const set = <K extends keyof ServerSettings>(k: K, v: ServerSettings[K]) => setF((p) => (p ? { ...p, [k]: v } : p));
  const setT = (k: keyof ServerSettings["thresholds"], v: number) => setF((p) => (p ? { ...p, thresholds: { ...p.thresholds, [k]: v } } : p));

  // The bar goes inert as it hides; hand focus back to the page rather than letting it drop to <body>.
  const settleFocus = () => {
    if (document.activeElement?.closest(`.${s.saveBar}`)) stackRef.current?.focus({ preventScroll: true });
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { detectedPrefixes: _d, baseDomain: _b, ...body } = f!;
      const next = await api.patch<ServerSettings>("/api/settings/server", body);
      setF(next);
      void mutate(next, { revalidate: false });
      toast.success("Server settings saved");
      settleFocus();
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, field: e.field } : { message: "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={stackRef} tabIndex={-1} className={`${s.stack} appear`}>
      <WorksWith />

      <Panel title="This server">
        <div className={s.row2}>
          <Field label="Name" description="Shown in the sidebar, sign-in page and notifications." error={error?.field === "serverName" ? error.message : null}>
            <Input value={f.serverName} onChange={(e) => set("serverName", e.target.value)} maxLength={40} />
          </Field>
          <Field label="Gluon's public address" description="For links in notifications. Leave empty if Gluon isn't on the internet." error={error?.field === "publicHost" ? error.message : null}>
            <Input value={f.publicHost} onChange={(e) => set("publicHost", e.target.value)} mono placeholder="gluon.example.com" spellCheck={false} autoCapitalize="none" />
          </Field>
        </div>
      </Panel>

      <Panel title="Home network">
        <p className={s.hint} style={{ marginBottom: 12 }}>
          Extra addresses that count as home. Private ranges like 192.168.x and Tailscale's 100.64.x always do.
        </p>
        {data.detectedPrefixes.length + f.homeNetworks.length > 0 && (
          <ul className={s.sortList} role="list">
            {[...data.detectedPrefixes.map((p) => ({ v: p, auto: true })), ...f.homeNetworks.map((v) => ({ v, auto: false }))].map((n) => (
              <li key={n.v} className={s.sortItem}>
                <span className={s.sortLabel}>
                  <span className="mono">{n.v}</span>
                  <small>{n.auto ? "Detected from this server's network" : "Added by you"}</small>
                </span>
                {!n.auto && (
                  <IconButton label={`Remove ${n.v}`} size="sm" onClick={() => set("homeNetworks", f.homeNetworks.filter((x) => x !== n.v))}>
                    <Trash />
                  </IconButton>
              )}
            </li>
          ))}
        </ul>
        )}
        <form
          className={s.row2}
          style={{ marginTop: 12, gridTemplateColumns: "1fr auto" }}
          onSubmit={(e) => {
            e.preventDefault();
            const v = cidr.trim();
            if (v && !f.homeNetworks.includes(v)) set("homeNetworks", [...f.homeNetworks, v]);
            setCidr("");
          }}
        >
          <Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="e.g. 100.64.0.0/10 for Tailscale" mono aria-label="Address range" />
          <Button type="submit" icon={<Plus />} disabled={!cidr.trim()}>
            Add range
          </Button>
        </form>
        {error?.field?.startsWith("homeNetworks") && (
          <p className={s.fieldError} role="alert">
            {error.message}
          </p>
        )}
        <p className={s.hint} style={{ marginTop: 10 }}>
          You're {viewer.zone === "home" ? "at home" : "away"} right now.
        </p>
      </Panel>

      <Panel title="Signing in">
        <SettingRow label="Who needs two-step sign-in" description={MFA_EXPLAIN[f.mfaPolicy]} stack>
          <Select aria-label="Who needs two-step sign-in" value={f.mfaPolicy} onChange={(v) => set("mfaPolicy", v)} options={MFA_OPTIONS} />
        </SettingRow>
        {f.mfaPolicy === "off" && (
          <div className={s.noticeRow}>
            <Notice tone="attention" title="Anyone with an admin's password could run this server from anywhere">
              Gluon can change anything on this machine. Ask admins for a code away from home, at least.
            </Notice>
          </div>
        )}
        <SettingRow label="Shortest password" description="Applies to new passwords. Current ones keep working." stack>
          <AffixInput
            type="number"
            inputMode="numeric"
            min={4}
            max={64}
            value={f.passwordPolicy.minLength}
            onChange={(e) => set("passwordPolicy", { ...f.passwordPolicy, minLength: Math.max(4, Math.min(64, Math.round(Number(e.target.value)) || 4)) })}
            after="characters"
            aria-label="Shortest password"
            className={s.charsInput}
          />
        </SettingRow>
        {f.passwordPolicy.minLength < 8 && (
          <div className={s.noticeRow}>
            <Notice tone="attention" title="Short passwords are easy to guess">
              Repeated guesses are slowed down, but 8 characters or more is much harder to break.
            </Notice>
          </div>
        )}
        <SettingRow label="Not the same as the username">
          <Switch checked={f.passwordPolicy.notUsername} onChange={(v) => set("passwordPolicy", { ...f.passwordPolicy, notUsername: v })} aria-label="Not the same as the username" />
        </SettingRow>
        <SettingRow label="Letters and numbers" description="A long phrase beats a short mix, so this starts off.">
          <Switch checked={f.passwordPolicy.lettersAndNumbers} onChange={(v) => set("passwordPolicy", { ...f.passwordPolicy, lettersAndNumbers: v })} aria-label="Letters and numbers" />
        </SettingRow>
        <SettingRow label="Stay signed in at home for" description="Counted from the last visit.">
          <DaysInput value={f.sessionDays} onChange={(v) => set("sessionDays", v)} label="Days at home" />
        </SettingRow>
        <SettingRow label="Stay signed in away from home for" description="Shorter suits phones and laptops. At most the home limit.">
          <DaysInput value={f.awaySessionDays} onChange={(v) => set("awaySessionDays", v)} label="Days away" />
        </SettingRow>
        <SettingRow label="Household can see Status" description="A simple “is it working?” page for their apps. No disks, logs or settings.">
          <Switch checked={f.householdCanSeeStatus} onChange={(v) => set("householdCanSeeStatus", v)} aria-label="Household can see Status" />
        </SettingRow>
      </Panel>

      <Panel title="When to raise an alert">
        <SettingRow label="Disk needs attention at">
          <Threshold value={f.thresholds.diskAttention} min={50} max={99} unit="% full" label="Disk needs attention at" onChange={(v) => setT("diskAttention", v)} />
        </SettingRow>
        <SettingRow label="Disk is urgent at">
          <Threshold value={f.thresholds.diskFault} min={50} max={100} unit="% full" label="Disk is urgent at" onChange={(v) => setT("diskFault", v)} />
        </SettingRow>
        <SettingRow label="Memory needs attention at">
          <Threshold value={f.thresholds.memoryAttention} min={50} max={100} unit="% used" label="Memory needs attention at" onChange={(v) => setT("memoryAttention", v)} />
        </SettingRow>
        <SettingRow label="Processor too hot at">
          <Threshold value={f.thresholds.tempAttention} min={40} max={110} unit="°C" label="Processor too hot at" onChange={(v) => setT("tempAttention", v)} />
        </SettingRow>
        <SettingRow label="Warn before certificates expire">
          <Threshold value={f.thresholds.certDays} min={1} max={60} unit="days" label="Days of warning before certificates expire" onChange={(v) => setT("certDays", v)} />
        </SettingRow>
      </Panel>

      {/* Rises from the bottom edge only while there's something to save, so it's in reach on a long page. */}
      <div className={s.saveBar} data-shown={dirty || busy ? "" : undefined} role="region" aria-label="Unsaved changes" inert={!dirty && !busy}>
        <span className={s.saveText}>
          {error && !error.field ? (
            <span className={s.fieldError} role="alert">
              {error.message}
            </span>
          ) : (
            "Unsaved changes"
          )}
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            setF(data);
            settleFocus();
          }}
        >
          Discard
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
