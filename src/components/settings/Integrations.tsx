"use client";
import * as React from "react";
import { EditPencil, LogIn, MoreHoriz, Plus, Refresh, Trash } from "iconoir-react";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Checkbox, Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import {
  JSON_FIELD_FORMATS,
  WIDGET_LABELS,
  type Integration,
  type IntegrationField,
  type IntegrationKind,
  type IntegrationKindInfo,
  type AppService,
  type InstalledApp,
  type IntegrationTestResult,
  type WidgetCatalog,
  type JsonFieldFormat,
} from "@/lib/widgets-types";
import s from "./settings.module.css";
import x from "./integrations.module.css";
import { ConnectDialog, type ConnectTarget } from "@/components/home/connect/Connect";

const KIND_ICON: Partial<Record<IntegrationKind, string>> = {
  jellyfin: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/jellyfin.svg",
  immich: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/immich.svg",
  subsonic: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/navidrome.svg",
  slskd: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/slskd.svg",
  homebridge: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/homebridge.svg",
};

const FORMAT_LABEL: Record<JsonFieldFormat, string> = {
  text: "Text",
  number: "Number",
  bytes: "Size (bytes)",
  percent: "Percent",
  duration: "Duration (seconds)",
  date: "Date",
  relative: "Time ago",
  boolean: "Yes / no",
};

type FormState =
  | {
      mode: "create";
      kind?: IntegrationKind;
      prefill?: {
        name: string;
        baseUrl: string;
        config: Record<string, unknown>;
        appId: string | null;
        note: string | null;
      };
    }
  | { mode: "edit"; integration: Integration };

// ================================================================= page

export function Integrations() {
  const { viewer } = usePrefs();
  const list = useApi<Integration[]>(viewer.role === "admin" ? "/api/integrations" : null, { refresh: 60_000 });
  const kinds = useApi<IntegrationKindInfo[]>(viewer.role === "admin" ? "/api/integrations/kinds" : null, { revalidateOnFocus: false });
  // Installed apps and what Gluon can read from them (the same list the widget catalog shows).
  const catalog = useApi<WidgetCatalog>(viewer.role === "admin" ? "/api/widgets/catalog" : null, { refresh: 60_000 });
  const [form, setForm] = React.useState<FormState | null>(null);
  const [connect, setConnect] = React.useState<ConnectTarget | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const [testing, setTesting] = React.useState<string | null>(null);

  if (viewer.role !== "admin") return <Notice>Only admins can manage connected apps.</Notice>;

  const kindInfo = (k: IntegrationKind) => kinds.data?.find((i) => i.kind === k);
  const refresh = () => {
    void list.mutate();
    void catalog.mutate();
  };

  async function test(it: Integration) {
    setTesting(it.id);
    try {
      const r = await api.post<IntegrationTestResult>(`/api/integrations/${encodeURIComponent(it.id)}/test`);
      if (r.ok) toast.success(r.message, r.detail ? { description: r.detail } : undefined);
      else toast.error(`${it.name} isn't working`, { description: r.message });
      void list.mutate();
    } catch (e) {
      toast.error("Couldn't run the test", {
        description: e instanceof ApiError ? e.message : undefined,
      });
    } finally {
      setTesting(null);
    }
  }

  async function share(it: Integration, shared: boolean) {
    void list.mutate((cur) => cur?.map((i) => (i.id === it.id ? { ...i, shared } : i)), { revalidate: false });
    try {
      await api.patch(`/api/integrations/${encodeURIComponent(it.id)}`, {
        shared,
      });
      toast.success(shared ? `${it.name} is shared with the household` : `Only admins can use ${it.name} now`);
    } catch (e) {
      toast.error("Couldn't change sharing", {
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
    void list.mutate();
  }

  function remove(it: Integration) {
    confirm({
      title: `Remove ${it.name}?`,
      consequences: [
        `Widgets that show ${it.name} stop showing its data, on everyone's home page.`,
        "Gluon forgets the saved key or password. Nothing changes inside the app itself.",
      ],
      confirmLabel: "Remove connection",
      variant: "danger",
      onConfirm: async () => {
        await api.del(`/api/integrations/${encodeURIComponent(it.id)}`);
        toast.success(`Removed ${it.name}`);
        refresh();
      },
    });
  }

  const items = list.data ?? [];
  const shared = items.filter((i) => i.shared).length;
  const broken = items.filter((i) => i.status.ok === false).length;
  const apps = catalog.data?.apps ?? [];
  const open = apps.filter((a) => !a.duplicate).flatMap((a) => a.services.filter((sv) => sv.state === "none" && sv.connect).map((sv) => ({ app: a, sv })));
  const appOf = (it: Integration): InstalledApp | undefined =>
    apps.find((a) => a.services.some((sv) => sv.integrationId === it.id)) ?? (it.appId ? apps.find((a) => a.appId === it.appId) : undefined);
  const serviceOf = (it: Integration): AppService | undefined => appOf(it)?.services.find((sv) => sv.integrationId === it.id);
  const reconnect = (it: Integration) => {
    const app = appOf(it);
    const sv = serviceOf(it);
    if (!app || !sv) return;
    setConnect({
      appId: app.appId,
      appName: app.name,
      icon: app.icon,
      line: app.line,
      service: {
        ...sv,
        connect: sv.connect ? { ...sv.connect, baseUrl: it.baseUrl } : sv.connect,
      },
      integrationId: it.id,
    });
  };

  return (
    <div className={s.stack}>
      <p className={x.summary}>
        {!list.data
          ? "Checking what's connected…"
          : items.length === 0
            ? open.length
              ? `Nothing connected yet. ${open.length === 1 ? "1 app on this server is" : `${open.length} apps on this server are`} ready${open.some((o) => o.sv.connect?.signIn) ? "; Jellyfin and Immich only need you to sign in" : ""}.`
              : "Nothing connected yet."
            : `${broken ? `${broken === 1 ? "1 connection isn't" : `${broken} connections aren't`} working. ` : ""}${items.length === 1 ? "1 app" : `${items.length} apps`} connected${shared ? `, ${shared} shared with the household` : ""}.${open.length ? ` ${open.length === 1 ? "1 more is" : `${open.length} more are`} ready to connect.` : ""}`}
      </p>

      {(items.length > 0 || !list.data || list.error || (catalog.data && open.length === 0)) && (
        <Panel
          title="Connections"
          flush
          meta={
            <Button size="sm" icon={<Plus />} onClick={() => setForm({ mode: "create" })} disabled={!kinds.data}>
              Connect an app
            </Button>
          }
        >
          {list.error && !list.data ? (
            <div className={x.pad}>
              <Notice
                tone="fault"
                title="Couldn't load connections"
                action={
                  <Button size="sm" onClick={() => list.mutate()}>
                    Try again
                  </Button>
                }
              >
                {list.error.message}
              </Notice>
            </div>
          ) : !list.data ? (
            <ul className={x.list} aria-busy="true">
              {[0, 1].map((i) => (
                <li key={i} className={x.row}>
                  <Skeleton width={32} height={32} radius={8} />
                  <span style={{ display: "grid", gap: 6 }}>
                    <Skeleton width="40%" height={13} />
                    <Skeleton width="60%" height={11} />
                  </span>
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <div className={x.pad}>
              <Empty title="No connected apps">
                Connect Jellyfin, Immich, your music server and others. Their widgets then appear in “Add a widget” on the home page, for everyone you share them with.
                {open.length > 0 ? " Gluon found some on this server below; Jellyfin and Immich only need you to sign in." : ""}
              </Empty>
            </div>
          ) : (
            <ul className={x.list} role="list">
              {items.map((it) => (
                <li key={it.id} className={x.row} id={`integration-${it.id}`}>
                  <AppIcon src={appOf(it)?.icon ?? KIND_ICON[it.kind] ?? null} name={it.name} size={32} />
                  <div className={x.text}>
                    <span className={x.name}>
                      <span className="truncate" title={it.name}>
                        {it.name}
                      </span>
                      <span className={x.kind}>{appOf(it) && appOf(it)!.name !== it.name ? `in ${appOf(it)!.name}` : (kindInfo(it.kind)?.label ?? it.kind)}</span>
                    </span>
                    <span className={`${x.address} mono`} title={it.baseUrl}>
                      {it.baseUrl}
                    </span>
                    <StatusLine it={it} />
                  </div>
                  <label className={x.share}>
                    <Switch checked={it.shared} onChange={(v) => void share(it, v)} aria-label={`Share ${it.name} with the household`} />
                    <span>Household can use</span>
                  </label>
                  <div className={x.actions}>
                    <Button size="sm" icon={<Refresh />} loading={testing === it.id} onClick={() => void test(it)}>
                      Check
                    </Button>
                    <Menu
                      trigger={
                        <IconButton label={`${it.name} options`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={[
                        ...(serviceOf(it)?.connect?.signIn
                          ? [
                              {
                                label: `Sign in to ${kindInfo(it.kind)?.label ?? it.name} again`,
                                description: "Gluon makes a fresh key named “Gluon”",
                                icon: <LogIn />,
                                onSelect: () => reconnect(it),
                              },
                            ]
                          : []),
                        {
                          label: "Edit",
                          icon: <EditPencil />,
                          onSelect: () => setForm({ mode: "edit", integration: it }),
                        },
                        "separator",
                        {
                          label: "Remove",
                          icon: <Trash />,
                          danger: true,
                          onSelect: () => remove(it),
                        },
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {items.length > 0 && (
        <p className={s.hint}>
          <b>Household can use</b> lets everyone signed in add that app's widgets: what's playing, new posters, photo counts, accessory states. They never see the key or the
          address, and can't change anything in the app. Off means only admins can.
        </p>
      )}

      {(open.length > 0 || catalog.isLoading) && (
        <Panel
          title="Ready to connect on this server"
          flush
          meta={
            items.length === 0 && list.data ? (
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setForm({ mode: "create" })} disabled={!kinds.data}>
                Another app
              </Button>
            ) : undefined
          }
        >
          {!catalog.data ? (
            <div className={x.pad}>
              <Skeleton height={44} />
            </div>
          ) : (
            <ul className={x.list} role="list">
              {open.map(({ app, sv }) => (
                <li key={sv.key} className={x.row} data-suggestion="">
                  <AppIcon src={app.icon ?? KIND_ICON[sv.kind] ?? null} name={app.name} size={32} />
                  <div className={x.text}>
                    <span className={x.name}>
                      <span className="truncate">{sv.label}</span>
                      {app.name !== sv.label && <span className={x.kind}>in {app.name}</span>}
                    </span>
                    <span className={`${x.address} mono`}>{sv.connect?.baseUrl}</span>
                    {sv.line !== "running" && (
                      <span className={x.status}>
                        <StateLine state={sv.line} size={11} /> Not running right now
                      </span>
                    )}
                    {sv.connect?.note && <span className={x.note}>{sv.connect.note}</span>}
                  </div>
                  <div className={x.actions}>
                    <Button
                      size="sm"
                      onClick={() =>
                        setConnect({
                          appId: app.appId,
                          appName: app.name,
                          icon: app.icon,
                          line: app.line,
                          service: sv,
                        })
                      }
                    >
                      {sv.connect?.signIn ? "Sign in to connect" : "Connect"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {catalog.data && open.length === 0 && apps.some((a) => a.services.length > 0) && <p className={s.hint}>Everything Gluon can read from on this server is connected.</p>}

      <ConnectDialog target={connect} open={!!connect} onOpenChange={(o) => !o && setConnect(null)} onConnected={refresh} />
      {form && kinds.data && (
        <IntegrationForm
          key={form.mode === "edit" ? form.integration.id : `new:${form.kind ?? ""}:${form.prefill?.baseUrl ?? ""}`}
          state={form}
          kinds={kinds.data}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refresh();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function StatusLine({ it }: { it: Integration }) {
  if (it.status.ok === true) {
    return (
      <span className={x.status}>
        <StateLine state="running" size={11} /> Working
        {it.status.checkedAt ? (
          <>
            {" "}
            · checked <Time ts={it.status.checkedAt} />
          </>
        ) : null}
      </span>
    );
  }
  if (it.status.ok === false) {
    return (
      <span className={x.status} data-fault="" title={it.status.message ?? undefined}>
        <StateLine state="unhealthy" size={11} /> <span className="truncate">{it.status.message ?? "Not working"}</span>
      </span>
    );
  }
  return (
    <span className={x.status}>
      <StateLine state="unknown" size={11} /> Not checked since Gluon started
    </span>
  );
}

// ================================================================= form

type Config = Record<string, unknown>;
interface Header {
  name: string;
  value: string;
}
interface JsonField {
  label: string;
  path: string;
  format: JsonFieldFormat;
}

function initialConfig(info: IntegrationKindInfo, base: Config): Config {
  const c: Config = { ...base };
  for (const f of info.fields) {
    if (c[f.key] !== undefined) continue;
    if (f.type === "boolean") c[f.key] = false;
    else if (f.type === "headers") c[f.key] = [];
    else if (f.type === "fields") c[f.key] = [{ label: "", path: "", format: "text" }];
    else if (f.type === "select") c[f.key] = f.options?.[0]?.value ?? "";
    else c[f.key] = "";
  }
  return c;
}

function IntegrationForm({ state, kinds, onClose, onSaved }: { state: FormState; kinds: IntegrationKindInfo[]; onClose: () => void; onSaved: () => void }) {
  const editing = state.mode === "edit" ? state.integration : null;
  const [kind, setKind] = React.useState<IntegrationKind | null>(editing?.kind ?? (state.mode === "create" ? (state.kind ?? null) : null));
  const info = kind ? kinds.find((k) => k.kind === kind)! : null;
  const prefill = state.mode === "create" ? state.prefill : undefined;
  const [name, setName] = React.useState(editing?.name ?? prefill?.name ?? info?.label ?? "");
  const [baseUrl, setBaseUrl] = React.useState(editing?.baseUrl ?? prefill?.baseUrl ?? "");
  const [config, setConfig] = React.useState<Config>(() => (info ? initialConfig(info, editing?.config ?? prefill?.config ?? {}) : {}));
  const [shared, setShared] = React.useState(editing?.shared ?? false);
  const [result, setResult] = React.useState<IntegrationTestResult | null>(null);
  const [busy, setBusy] = React.useState<"test" | "save" | null>(null);
  const [error, setError] = React.useState<{
    message: string;
    field?: string;
  } | null>(null);

  const pick = (k: IntegrationKind) => {
    const i = kinds.find((x) => x.kind === k)!;
    setKind(k);
    setName(i.label);
    setConfig(initialConfig(i, {}));
    setResult(null);
    setError(null);
  };
  const set = (k: string, v: unknown) => {
    setConfig((c) => ({ ...c, [k]: v }));
    setResult(null);
  };

  function payloadConfig(): Config {
    const out: Config = {};
    for (const [k, v] of Object.entries(config)) {
      if (k === "userId") out[k] = v === "auto" ? "" : v;
      else if (k === "fields" && Array.isArray(v)) out[k] = (v as JsonField[]).filter((f) => f.label.trim() || f.path.trim());
      else if (k === "headers" && Array.isArray(v)) out[k] = (v as Header[]).filter((h) => h.name.trim());
      else out[k] = v;
    }
    return out;
  }

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError) setError({ message: e.message, field: e.field });
    else setError({ message: fallback });
  };

  async function runTest() {
    if (!kind) return;
    setBusy("test");
    setError(null);
    try {
      const r = await api.post<IntegrationTestResult>("/api/integrations/test", { kind, baseUrl, config: payloadConfig(), id: editing?.id });
      setResult(r);
    } catch (e) {
      fail(e, "Couldn't run the test.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!kind) return;
    setBusy("save");
    setError(null);
    try {
      if (editing) {
        await api.patch(`/api/integrations/${encodeURIComponent(editing.id)}`, {
          name,
          baseUrl,
          config: payloadConfig(),
          shared,
        });
        toast.success(`Saved ${name}`);
      } else {
        const r = await api.post<{
          integration: Integration;
          test: IntegrationTestResult | null;
        }>("/api/integrations", {
          kind,
          name,
          baseUrl,
          config: payloadConfig(),
          shared,
          appId: prefill?.appId ?? null,
        });
        if (r.test && !r.test.ok)
          toast.attention(`Saved ${name}, but it isn't working yet`, {
            description: r.test.message,
          });
        else toast.success(`Connected ${name}`, r.test?.detail ? { description: r.test.detail } : undefined);
      }
      onSaved();
    } catch (e) {
      fail(e, "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  const fieldError = (key: string) => (error?.field === `config.${key}` || error?.field?.startsWith(`config.${key}.`) ? error.message : null);
  const visible = (f: IntegrationField) => !f.showWhen || f.showWhen.in.includes(String(config[f.showWhen.key] ?? ""));
  const widgetNames = info ? info.widgets.map((w) => WIDGET_LABELS[w].label.toLowerCase()) : [];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title={editing ? `Edit ${editing.name}` : info ? `Connect ${info.label}` : "Connect an app"}
      description={info ? info.description : "Pick what to connect. You'll need its address and a key or login."}
      footerStart={
        info ? (
          <Button icon={<Refresh />} loading={busy === "test"} disabled={!baseUrl.trim() || busy === "save"} onClick={() => void runTest()}>
            Test connection
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {info && (
            <Button variant="primary" loading={busy === "save"} disabled={!name.trim() || !baseUrl.trim() || busy === "test"} onClick={() => void save()}>
              {editing ? "Save changes" : `Connect ${info.label}`}
            </Button>
          )}
        </>
      }
    >
      {!info ? (
        <div className={x.kinds}>
          {kinds.map((k) => (
            <button key={k.kind} type="button" className={x.kindChoice} onClick={() => pick(k.kind)}>
              <AppIcon src={KIND_ICON[k.kind] ?? null} name={k.label} size={28} />
              <span>
                <b>{k.label}</b>
                {k.description}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <form
          className={x.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {prefill?.note && <Notice>{prefill.note}</Notice>}
          <Notice title={info.kind === "generic-json" ? "How it works" : "Where to find the key"}>{info.keyHelp}</Notice>

          <div className={s.row2}>
            <Field label="Name" description="How it's listed when people add widgets." error={error?.field === "name" ? error.message : null}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </Field>
            <Field
              label={info.baseUrlLabel}
              description={info.kind === "generic-json" ? "The full address that returns JSON." : "Addresses like 127.0.0.1 reach apps on this server directly."}
              error={error?.field === "baseUrl" ? error.message : null}
            >
              <Input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setResult(null);
                }}
                placeholder={info.baseUrlPlaceholder}
                mono
                inputMode="url"
                autoCapitalize="none"
                autoComplete="off"
              />
            </Field>
          </div>

          {info.fields.filter(visible).map((f) => (
            <KindField
              key={`${f.key}:${f.showWhen?.in.join() ?? ""}`}
              f={f}
              value={config[f.key]}
              onChange={(v) => set(f.key, v)}
              secret={editing?.secrets[f.key]}
              users={result?.options?.users}
              error={fieldError(f.key)}
            />
          ))}

          <SettingRow
            label="Share with the household"
            description={`Everyone signed in can add ${widgetNames.length ? widgetNames.join(", ") : "its"} widgets. They never see the key or the address, and can't change anything in ${info.label}.`}
          >
            <Switch checked={shared} onChange={setShared} aria-label="Share with the household" />
          </SettingRow>

          {result && <TestResult r={result} />}
          {error && !error.field?.startsWith("config.") && error.field !== "name" && error.field !== "baseUrl" && <Notice tone="fault">{error.message}</Notice>}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function TestResult({ r }: { r: IntegrationTestResult }) {
  return (
    <div className={x.result} aria-live="polite">
      <Notice tone={r.ok ? "neutral" : "fault"} title={r.message}>
        {r.ok ? `Answered in ${r.ms} ms.` : "Nothing was saved. Fix the address or key and test again."}
      </Notice>
      {r.detail && <Notice tone="attention">{r.detail}</Notice>}
      {r.preview && r.preview.length > 0 && (
        <dl className={x.preview}>
          {r.preview.map((p, i) => (
            <React.Fragment key={`${p.label}:${i}`}>
              <dt>{p.label}</dt>
              <dd className={p.missing ? "muted" : "num"}>{p.missing ? "Nothing at this path" : p.display}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function KindField({
  f,
  value,
  onChange,
  secret,
  users,
  error,
}: {
  f: IntegrationField;
  value: unknown;
  onChange: (v: unknown) => void;
  secret?: { set: boolean; hint: string | null };
  users?: { id: string; name: string }[];
  error: string | null;
}) {
  if (f.type === "boolean") {
    return (
      <Checkbox checked={!!value} onChange={onChange}>
        {f.label}
      </Checkbox>
    );
  }
  if (f.type === "headers") return <HeadersEditor f={f} value={(value as Header[]) ?? []} onChange={onChange} saved={!!secret?.set} error={error} />;
  if (f.type === "fields") return <FieldsEditor value={(value as JsonField[]) ?? []} onChange={onChange} error={error} />;
  if (f.type === "select") {
    let options = f.options ?? [];
    if (f.key === "userId") {
      const cur = typeof value === "string" && value && value !== "auto" ? value : null;
      options = [
        { value: "auto", label: "The first admin" },
        ...(users ?? []).map((u) => ({ value: u.id, label: u.name })),
        ...(cur && !users?.some((u) => u.id === cur)
          ? [
              {
                value: cur,
                label: users ? "Someone who no longer exists" : "The saved person",
              },
            ]
          : []),
      ];
    }
    return (
      <Field label={f.label} description={f.help} error={error} optional={!f.required}>
        <Select aria-label={f.label} value={String(value || (f.key === "userId" ? "auto" : (options[0]?.value ?? "")))} onChange={onChange} options={options} />
      </Field>
    );
  }
  const isSecret = f.secret || f.type === "password";
  const keep = isSecret && secret?.set;
  return (
    <Field
      label={f.label}
      description={keep ? `Saved${secret?.hint ? ` (${secret.hint})` : ""}. Leave blank to keep it.` : f.help}
      error={error}
      optional={!f.required && !isSecret}
    >
      <Input
        type={isSecret ? "password" : "text"}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={keep ? "••••••••" : f.placeholder}
        autoComplete={isSecret ? "new-password" : "off"}
        spellCheck={false}
        mono={isSecret}
      />
    </Field>
  );
}

function HeadersEditor({ f, value, onChange, saved, error }: { f: IntegrationField; value: Header[]; onChange: (v: Header[]) => void; saved: boolean; error: string | null }) {
  return (
    <Field label={f.label} description={f.help} error={error} optional>
      <div className={x.editor}>
        {value.map((h, i) => (
          <div key={i} className={x.editRow} data-cols="3">
            <Input
              value={h.name}
              onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))}
              placeholder="X-API-Key"
              aria-label="Header name"
              mono
            />
            <Input
              type="password"
              value={h.value}
              onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
              placeholder={saved && h.name ? "Saved, leave blank to keep" : "Value"}
              aria-label="Header value"
              autoComplete="new-password"
              mono
            />
            <IconButton label="Remove header" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus />} disabled={value.length >= 10} onClick={() => onChange([...value, { name: "", value: "" }])}>
            Add header
          </Button>
        </div>
      </div>
    </Field>
  );
}

function FieldsEditor({ value, onChange, error }: { value: JsonField[]; onChange: (v: JsonField[]) => void; error: string | null }) {
  const formats = JSON_FIELD_FORMATS.map((f) => ({
    value: f,
    label: FORMAT_LABEL[f],
  }));
  return (
    <Field label="Values to show" description="A label, where the value is in the JSON (like data.uptime or items.length), and how to show it." error={error}>
      <div className={x.editor}>
        {value.map((fl, i) => (
          <div key={i} className={x.editRow} data-cols="4">
            <Input
              value={fl.label}
              onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))}
              placeholder="Label"
              aria-label="Label"
              maxLength={40}
            />
            <Input
              value={fl.path}
              onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, path: e.target.value } : y)))}
              placeholder="data.uptime"
              aria-label="Path"
              mono
              spellCheck={false}
            />
            <Select aria-label="Show as" value={fl.format} onChange={(v) => onChange(value.map((y, j) => (j === i ? { ...y, format: v } : y)))} options={formats} />
            <IconButton label="Remove value" size="sm" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus />} disabled={value.length >= 12} onClick={() => onChange([...value, { label: "", path: "", format: "text" }])}>
            Add value
          </Button>
        </div>
      </div>
    </Field>
  );
}
