"use client";
import * as React from "react";
import { mutate } from "swr";
import { api, ApiError, useApi } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Switch } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine, lineLabel } from "@/components/ui/StateLine";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import type { AppService, Integration, IntegrationField, IntegrationKindInfo, IntegrationTestResult, SignInResult } from "@/lib/widgets-types";
import type { LineState } from "@/lib/types";
import c from "./connect.module.css";

/** What the connect step needs to know about the app it connects. */
export interface ConnectTarget {
  appId: string | null;
  appName: string;
  icon: string | null;
  line: LineState;
  service: AppService;
  /** Reconnect: replace the key of this saved connection. */
  integrationId?: string | null;
}

export interface Connected {
  integrationId: string;
  ok: boolean;
}

type Mode = "account" | "key";

const USER_LABEL: Record<string, string> = {
  jellyfin: "Jellyfin username",
  immich: "Immich email",
};

/** Refresh everything that lists connections, so widgets on the page pick the new one up straight away. */
export async function refreshConnections() {
  await Promise.all([mutate("/api/widgets/catalog"), mutate("/api/integrations"), mutate("/api/integrations/suggestions")]);
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * The compact "connect this app" step. Jellyfin and Immich default to signing in once (Gluon makes its own key);
 * other apps ask for their key or login right here. Used inside the widget catalog, from a widget, and in Settings.
 */
export function ConnectForm({
  target,
  onConnected,
  onCancel,
  cancelLabel = "Cancel",
}: {
  target: ConnectTarget;
  onConnected: (r: Connected) => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const { service } = target;
  const reconnect = !!target.integrationId;
  const signIn = !!service.connect?.signIn;
  const kinds = useApi<IntegrationKindInfo[]>(signIn ? null : "/api/integrations/kinds", { revalidateOnFocus: false });
  const info = kinds.data?.find((k) => k.kind === service.kind);

  const [mode, setMode] = React.useState<Mode>(signIn ? "account" : "key");
  const [baseUrl, setBaseUrl] = React.useState(service.connect?.baseUrl ?? "");
  const [editUrl, setEditUrl] = React.useState(!service.connect?.baseUrl);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [config, setConfig] = React.useState<Record<string, unknown>>(() => ({
    ...(service.connect?.config ?? {}),
  }));
  const [shared, setShared] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{
    message: string;
    field?: string;
  } | null>(null);
  const firstField = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  const set = (k: string, v: unknown) => {
    setConfig((cur) => ({ ...cur, [k]: v }));
    setError(null);
  };

  // Fields for the "key" step: the kind's own, minus advanced ones (self-signed TLS, the Jellyfin person picker).
  const keyFields: IntegrationField[] = signIn
    ? [
        {
          key: "apiKey",
          label: "API key",
          type: "password",
          required: true,
          secret: true,
        },
      ]
    : (info?.fields ?? []).filter(
        (f) => (f.type === "text" || f.type === "password" || f.type === "select") && (!f.showWhen || f.showWhen.in.includes(String(config[f.showWhen.key] ?? f.showWhen.in[0]))),
      );

  async function finish(integrationId: string, test: IntegrationTestResult | null, account?: string) {
    await refreshConnections();
    if (test && !test.ok) {
      toast.attention(`${service.label} is connected, but not answering yet`, {
        description: test.message,
      });
    } else {
      toast.success(`${reconnect ? "Reconnected" : "Connected"} ${service.label}`, {
        description: account ? `Signed in as ${account}. Gluon made its own key named “Gluon” and didn't keep your password.` : (test?.detail ?? undefined),
      });
    }
    onConnected({ integrationId, ok: !test || test.ok });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "account") {
        const r = await api.post<SignInResult>("/api/integrations/sign-in", {
          kind: service.kind,
          baseUrl,
          username,
          password,
          appId: target.appId,
          shared,
          name: service.label,
          integrationId: target.integrationId ?? undefined,
        });
        setPassword("");
        await finish(r.integration.id, r.test, r.account);
        return;
      }
      const payload = { ...config };
      if (reconnect) {
        await api.patch(`/api/integrations/${encodeURIComponent(target.integrationId!)}`, { baseUrl, config: payload });
        const test = await api.post<IntegrationTestResult>(`/api/integrations/${encodeURIComponent(target.integrationId!)}/test`);
        if (!test.ok) {
          setError({ message: test.message });
          await refreshConnections();
          return;
        }
        await finish(target.integrationId!, test);
        return;
      }
      // Test first, so a wrong key never leaves a broken connection behind.
      const test = await api.post<IntegrationTestResult>("/api/integrations/test", { kind: service.kind, baseUrl, config: payload });
      if (!test.ok) {
        setError({ message: test.message });
        return;
      }
      const r = await api.post<{
        integration: Integration;
        test: IntegrationTestResult | null;
      }>("/api/integrations", {
        kind: service.kind,
        name: service.label,
        baseUrl,
        config: payload,
        appId: target.appId,
        shared,
      });
      await finish(r.integration.id, r.test);
    } catch (err) {
      if (err instanceof ApiError) setError({ message: err.message, field: err.field });
      else
        setError({
          message: "Couldn't connect. Check the address and try again.",
        });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (key: string) => (error?.field === key || error?.field === `config.${key}` ? error.message : null);
  const canSubmit =
    !!baseUrl.trim() && (mode === "account" ? !!username.trim() && !!password : keyFields.filter((f) => f.required).every((f) => String(config[f.key] ?? "").trim()));

  return (
    <form className={c.form} onSubmit={submit} aria-busy={busy || undefined}>
      <div className={c.identity}>
        <AppIcon src={target.icon} name={target.appName} size={40} />
        <div className={c.identityText}>
          <span className={c.appName}>
            {service.label}
            {target.appName !== service.label && <span className={c.inApp}>in {target.appName}</span>}
          </span>
          <span className={c.where}>
            <StateLine state={service.line} size={11} />
            <span>{lineLabel(service.line)}</span>
            {!editUrl && (
              <>
                <span aria-hidden>·</span>
                <span className="mono truncate" title={baseUrl}>
                  {hostOf(baseUrl)}
                </span>
                <button type="button" className={c.textButton} onClick={() => setEditUrl(true)}>
                  Change
                </button>
              </>
            )}
          </span>
        </div>
      </div>

      {service.line === "stopped" && (
        <Notice tone="attention" title={`${target.appName} isn't running`}>
          Start it first. Gluon needs it running to connect.
        </Notice>
      )}
      {service.connect?.note && <p className={c.note}>{service.connect.note}</p>}

      {editUrl && (
        <Field
          label="Address"
          description="Found on this server. Addresses like 127.0.0.1 reach apps on this machine directly."
          error={error?.field === "baseUrl" ? error.message : null}
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            mono
            inputMode="url"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:8096"
          />
        </Field>
      )}

      {mode === "account" ? (
        <div className={c.fields}>
          <Field label={USER_LABEL[service.kind] ?? "Username"} error={fieldError("username")}>
            <Input
              ref={firstField}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode={service.kind === "immich" ? "email" : undefined}
            />
          </Field>
          <Field label="Password" error={fieldError("password")}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
          <p className={c.help}>
            Gluon signs in once to make its own {service.label} key named “Gluon”, then signs out. Your password isn't kept.
            {service.kind === "jellyfin" ? " Use an administrator's account." : " An admin account lets the widget show everyone's photos."}
          </p>
          <button type="button" className={c.switchMode} onClick={() => setMode("key")}>
            Paste an API key instead
          </button>
        </div>
      ) : !signIn && !info ? (
        <div className={c.fields}>
          <Skeleton height={34} />
          <Skeleton height={34} />
        </div>
      ) : (
        <div className={c.fields}>
          {keyFields.map((f, i) =>
            f.type === "select" ? (
              <Field key={f.key} label={f.label} description={f.help} error={fieldError(f.key)}>
                <Select aria-label={f.label} value={String(config[f.key] ?? f.options?.[0]?.value ?? "")} onChange={(v) => set(f.key, v)} options={f.options ?? []} />
              </Field>
            ) : (
              <Field key={f.key} label={f.label} error={fieldError(f.key)} optional={!f.required && f.type !== "password"}>
                <Input
                  ref={i === 0 ? firstField : undefined}
                  type={f.type === "password" ? "password" : "text"}
                  value={String(config[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  autoComplete={f.type === "password" ? "new-password" : "off"}
                  autoCapitalize="none"
                  spellCheck={false}
                  mono={f.secret}
                />
              </Field>
            ),
          )}
          <details className={c.howto}>
            <summary>Where to find {signIn ? "the key" : "these"}</summary>
            <p>{service.connect?.keyHelp}</p>
          </details>
          {!signIn && (
            <p className={c.help}>
              {service.kind === "homeassistant"
                ? "Stored encrypted on this server. Gluon uses it to read from Home Assistant, and to switch only the things you allow on Home controls."
                : `Stored encrypted on this server and only used to read from ${service.label}.`}
            </p>
          )}
          {signIn && (
            <button type="button" className={c.switchMode} onClick={() => setMode("account")}>
              Sign in with your {service.label} account instead
            </button>
          )}
        </div>
      )}

      {!reconnect && (
        <label className={c.share}>
          <span>
            <b>Household can use it</b>
            Everyone signed in can add {service.label} widgets. They never see the key.
          </span>
          <Switch checked={shared} onChange={setShared} aria-label="Household can use it" />
        </label>
      )}

      {error && !(error.field && ["username", "password", "baseUrl"].includes(error.field)) && !error.field?.startsWith("config.") && (
        <Notice tone="fault" title={`Couldn't connect ${service.label}`}>
          {error.message}
        </Notice>
      )}

      <div className={c.actions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          {busy ? (mode === "account" ? "Signing in…" : "Checking…") : reconnect ? `Reconnect ${service.label}` : `Connect ${service.label}`}
        </Button>
      </div>
    </form>
  );
}

/** The connect step in its own dialog (from a widget or Settings). */
export function ConnectDialog({
  target,
  open,
  onOpenChange,
  onConnected,
}: {
  target: ConnectTarget | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConnected?: (r: Connected) => void;
}) {
  return (
    <Dialog open={open && !!target} onOpenChange={onOpenChange} title={target ? `${target.integrationId ? "Reconnect" : "Connect"} ${target.service.label}` : "Connect"}>
      {target && (
        <ConnectForm
          key={`${target.service.key}:${target.integrationId ?? ""}`}
          target={target}
          onCancel={() => onOpenChange(false)}
          onConnected={(r) => {
            onConnected?.(r);
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}
