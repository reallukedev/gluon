"use client";
import * as React from "react";
import { Plus, Trash } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Panel, Skeleton, Notice } from "@/components/ui/Surface";
import { AffixInput, Field, Input, Switch, SettingRow } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { WorksWith } from "./WorksWith";
import s from "./settings.module.css";

interface ServerSettings {
  serverName: string;
  publicHost: string;
  baseDomain: string;
  homeNetworks: string[];
  detectedPrefixes: string[];
  requireMfaAway: boolean;
  sessionDays: number;
  awaySessionDays: number;
  householdCanSeeStatus: boolean;
  thresholds: { diskAttention: number; diskFault: number; tempAttention: number; certDays: number; memoryAttention: number };
}

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

export function Server() {
  const { data, mutate } = useApi<ServerSettings>("/api/settings/server");
  const { viewer } = usePrefs();
  const [f, setF] = React.useState<ServerSettings | null>(null);
  const [cidr, setCidr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { detectedPrefixes: _d, baseDomain: _b, ...body } = f!;
      const next = await api.patch<ServerSettings>("/api/settings/server", body);
      setF(next);
      void mutate(next, { revalidate: false });
      toast.success("Server settings saved");
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, field: e.field } : { message: "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${s.stack} appear`}>
      <WorksWith />

      <Panel title="This server">
        <div className={s.row2}>
          <Field label="Name" description="Shown in the sidebar, sign-in page and notifications." error={error?.field === "serverName" ? error.message : null}>
            <Input value={f.serverName} onChange={(e) => set("serverName", e.target.value)} maxLength={40} />
          </Field>
          <Field label="Gluon's public address" description="Where Gluon is reachable from the internet, if it is. Used for links in notifications." error={error?.field === "publicHost" ? error.message : null}>
            <Input value={f.publicHost} onChange={(e) => set("publicHost", e.target.value)} mono placeholder="gluon.example.com" spellCheck={false} autoCapitalize="none" />
          </Field>
        </div>
      </Panel>

      <Panel title="Home network">
        <p className={s.hint} style={{ marginBottom: 12 }}>
          Visitors from these addresses count as at home: they get home links to apps, and admins without two-step sign-in can sign in. Private ranges (192.168.x, 10.x,
          172.16–31.x, Tailscale's 100.64.x) and this server's own IPv6 prefix always count. Changing this list asks you to confirm it's you.
        </p>
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
        {error?.field?.startsWith("homeNetworks") && <p style={{ color: "var(--fault)", fontSize: "var(--text-sm)", marginTop: 8 }}>{error.message}</p>}
        <p className={s.hint} style={{ marginTop: 10 }}>
          You're {viewer.zone === "home" ? "at home" : "away"} right now.
        </p>
      </Panel>

      <Panel title="Signing in">
        <SettingRow
          label="Admins need two-step sign-in away from home"
          description="An admin signing in from outside the home network must also enter a code from their phone. Admins who haven't set it up can still sign in at home."
        >
          <Switch checked={f.requireMfaAway} onChange={(v) => set("requireMfaAway", v)} aria-label="Admins need two-step sign-in away from home" />
        </SettingRow>
        {!f.requireMfaAway && (
          <div style={{ padding: "0 0 14px" }}>
            <Notice tone="attention" title="Anyone with an admin's password could run this server from anywhere">
              Gluon can change anything on this machine. Keep this on unless every admin already uses two-step sign-in.
            </Notice>
          </div>
        )}
        <SettingRow label="Stay signed in at home for" description="Days without use before someone has to sign in again.">
          <DaysInput value={f.sessionDays} onChange={(v) => set("sessionDays", v)} label="Days at home" />
        </SettingRow>
        <SettingRow label="Stay signed in away from home for" description="Shorter is safer for phones and laptops that leave the house. Never longer than at home.">
          <DaysInput value={f.awaySessionDays} onChange={(v) => set("awaySessionDays", v)} label="Days away" />
        </SettingRow>
        <SettingRow label="Household can see Status" description="Members see a simple “is it working?” page for their apps. They never see disks, logs or settings.">
          <Switch checked={f.householdCanSeeStatus} onChange={(v) => set("householdCanSeeStatus", v)} aria-label="Household can see Status" />
        </SettingRow>
      </Panel>

      <Panel title="When to raise an alert">
        <div className={s.row2}>
          <Field label="Disk needs attention at" description="Percent full.">
            <Input type="number" min={50} max={99} value={f.thresholds.diskAttention} onChange={(e) => setT("diskAttention", Number(e.target.value))} />
          </Field>
          <Field label="Disk is urgent at" description="Percent full.">
            <Input type="number" min={50} max={100} value={f.thresholds.diskFault} onChange={(e) => setT("diskFault", Number(e.target.value))} />
          </Field>
          <Field label="Processor too hot at" description="°C.">
            <Input type="number" min={40} max={110} value={f.thresholds.tempAttention} onChange={(e) => setT("tempAttention", Number(e.target.value))} />
          </Field>
          <Field label="Memory needs attention at" description="Percent used.">
            <Input type="number" min={50} max={100} value={f.thresholds.memoryAttention} onChange={(e) => setT("memoryAttention", Number(e.target.value))} />
          </Field>
          <Field label="Warn about certificates" description="Days before they expire.">
            <Input type="number" min={1} max={60} value={f.thresholds.certDays} onChange={(e) => setT("certDays", Number(e.target.value))} />
          </Field>
        </div>
      </Panel>

      {error && !error.field && <p style={{ color: "var(--fault)", fontSize: "var(--text-sm)" }}>{error.message}</p>}
      <div className={s.actions}>
        <Button variant="ghost" disabled={!dirty} onClick={() => setF(data)}>
          Discard
        </Button>
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
