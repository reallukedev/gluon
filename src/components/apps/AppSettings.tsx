"use client";
import * as React from "react";
import type { AppDetail } from "@/server/docker/detail";
import { api, ApiError } from "@/lib/client/api";
import { Panel } from "@/components/ui/Surface";
import { Field, Input, Switch, SettingRow, Checkbox, Segmented } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "./AppIcon";
import s from "./settings.module.css";

export function AppSettings({ app, members, onSaved }: { app: AppDetail; members: { id: string; name: string }[]; onSaved: () => void }) {
  const [f, setF] = React.useState({
    displayName: app.name,
    description: app.description ?? "",
    icon: app.icon ?? "",
    urlHome: "",
    urlAway: "",
    household: app.household,
    hasLogin: app.hasLogin,
    hidden: app.hidden,
    access: app.access.map((a) => a.userId),
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/apps/${encodeURIComponent(app.id)}/prefs`, {
        displayName: f.displayName,
        description: f.description,
        icon: f.icon,
        urlHome: f.urlHome || undefined,
        urlAway: f.urlAway || undefined,
        household: f.household,
        hasLogin: f.hasLogin,
        hidden: f.hidden,
        access: f.access,
      });
      toast.success("Saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, field: e.field } : { message: "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }
  const err = (field: string) => (error?.field === field ? error.message : null);

  return (
    <div className={s.stack}>
      <Panel title="How it appears">
        <div className={s.form}>
          <div className={s.nameRow}>
            <AppIcon src={f.icon || null} name={f.displayName || app.id} size={48} />
            <Field label="Name" error={err("displayName")}>
              <Input value={f.displayName} onChange={(e) => set("displayName", e.target.value)} maxLength={60} />
            </Field>
          </div>
          <Field label="Description" optional description="Shown to household members under the app's name.">
            <Input value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={200} placeholder="e.g. Films and TV" />
          </Field>
          <Field label="Icon address" optional error={err("icon")} description="A link to a PNG or SVG. Leave empty to use the one CasaOS or the image provides.">
            <Input value={f.icon} onChange={(e) => set("icon", e.target.value)} mono inputMode="url" />
          </Field>
        </div>
      </Panel>

      <Panel title="Addresses">
        <div className={s.form}>
          <p className={s.hint}>
            Gluon works these out from the app's port and public addresses. Override them only if the app lives at a different path or you use another domain.
          </p>
          <Field label="At home" optional error={err("urlHome")} description={app.urls.home ? `Now: ${app.urls.home}` : undefined}>
            <Input value={f.urlHome} onChange={(e) => set("urlHome", e.target.value)} mono placeholder={app.urls.home ?? "http://192.168.1.10:8080"} inputMode="url" />
          </Field>
          <Field label="From anywhere" optional error={err("urlAway")} description={app.urls.away ? `Now: ${app.urls.away}` : "Not published. Publish it from Network → Public addresses."}>
            <Input value={f.urlAway} onChange={(e) => set("urlAway", e.target.value)} mono placeholder={app.urls.away ?? "https://photos.example.com"} inputMode="url" />
          </Field>
        </div>
      </Panel>

      <Panel title="Household">
        <SettingRow label="Show to everyone in the household" description="It appears on their home page and status page, with the right address for where they are.">
          <Switch checked={f.household} onChange={(v) => set("household", v)} aria-label="Show to everyone in the household" />
        </SettingRow>
        {!f.household && members.length > 0 && (
          <div className={s.access}>
            <p className={s.hint}>Or only to:</p>
            <div className={s.people}>
              {members.map((m) => (
                <Checkbox key={m.id} checked={f.access.includes(m.id)} onChange={(v) => set("access", v ? [...f.access, m.id] : f.access.filter((x) => x !== m.id))}>
                  {m.name}
                </Checkbox>
              ))}
            </div>
          </div>
        )}
        <SettingRow label="Hide from lists" description="Keep it off Apps and Status (it still runs). Useful for helper containers.">
          <Switch checked={f.hidden} onChange={(v) => set("hidden", v)} aria-label="Hide from lists" />
        </SettingRow>
      </Panel>

      <Panel title="Security">
        <SettingRow stack label="Does it have its own login?" description="Gluon uses this to warn you before publishing an app anyone could use, and in the exposure check.">
          <Segmented
            aria-label="Has its own login"
            value={f.hasLogin}
            onChange={(v) => set("hasLogin", v)}
            options={[
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
              { value: "unknown", label: "Not sure" },
            ]}
          />
        </SettingRow>
      </Panel>

      {error && !error.field && <p className={s.error}>{error.message}</p>}
      <div className={s.actions}>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
