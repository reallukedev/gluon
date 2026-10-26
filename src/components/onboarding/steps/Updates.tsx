"use client";
import * as React from "react";
import type { Install, UpdateChannel, UpdateSettings, UpdatesStatus } from "@/lib/updates-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Segmented, SettingRow, Switch } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Actions, PartError, StepHead, hourLabel, useFlow } from "../flow";
import o from "../onboarding.module.css";

function installedHow(i: Install): string {
  switch (i.kind) {
    case "umbrel":
      return "It was installed through Umbrel.";
    case "casaos":
      return "It was installed through CasaOS.";
    case "compose":
      return "It runs with Docker Compose.";
    case "docker":
      return "It was started with docker run.";
    case "development":
      return "This is a development copy.";
    default:
      return "";
  }
}

const CHANNELS: { value: UpdateChannel; title: string; body: string }[] = [
  { value: "stable", title: "Stable", body: "Tested releases. The safe choice for a server the household relies on." },
  { value: "nightly", title: "Nightly", body: "Every change as it's made. New things first, and now and then a new bug." },
];

/**
 * Admin: how Gluon updates itself (server-wide, so only shown until someone has chosen). Saving asks
 * for the password again if the sign-in is more than a few minutes old: automatic updates install
 * code as root.
 */
export function UpdatesStep() {
  const { next } = useFlow();
  const { prefs } = usePrefs();
  const { data, error, mutate } = useApi<UpdatesStatus>("/api/updates", { revalidateOnFocus: false });
  const [edits, setEdits] = React.useState<UpdateSettings | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // The server's settings until the first change (derived here, so there's no extra skeleton render).
  const draft = edits ?? (data ? { ...data.settings, nightlyTiming: data.settings.nightlyTiming ?? "hour" } : null);

  const set = (patch: Partial<UpdateSettings>) => {
    setEdits((d) => {
      const base = d ?? draft;
      return base ? { ...base, ...patch } : base;
    });
    setSaveError(null);
  };

  const dev = data?.install.kind === "development";
  const canAuto = !!data?.canSelfUpdate;

  async function save() {
    if (!draft || dev) return next();
    setBusy(true);
    setSaveError(null);
    try {
      await api.put("/api/updates/settings", canAuto ? draft : { ...draft, auto: false });
      next();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setSaveError(e instanceof Error ? e.message : "Couldn't save that.");
    }
  }

  const version = data?.running.version;
  return (
    <>
      <StepHead title="How should Gluon update itself?">
        {data ? (
          <p>
            You&apos;re running Gluon <span className="num">{version}</span>. {installedHow(data.install)}
          </p>
        ) : (
          <p>New versions of Gluon fix problems and add things. Choose which ones to follow and whether to install them for you.</p>
        )}
      </StepHead>

      {error && !data ? (
        <PartError message={`Couldn't read how Gluon is installed. ${error.message}`} onRetry={() => void mutate()} />
      ) : !data || !draft ? (
        <div className={o.stack} aria-busy>
          <div className={o.choices}>
            <Skeleton height={86} radius={10} />
            <Skeleton height={86} radius={10} />
          </div>
          <Skeleton height={64} radius={10} />
        </div>
      ) : (
        <div className={o.stack}>
          {!canAuto && (
            <Notice tone="neutral" title={dev ? "This copy doesn't update itself" : "Gluon can't update itself here"}>
              {dev
                ? "It runs from source, so pull the changes and restart it to update. Nothing to choose here."
                : `${data.options.find((x) => !x.available)?.reason ?? "Gluon couldn't tell how it was installed."} It will still tell you when a new version is out.`}
            </Notice>
          )}

          {!dev && (
            <ChannelChoice value={draft.channel} onChange={(channel) => set({ channel })} />
          )}

          {!dev && canAuto && (
            <div className={o.rowsPanel}>
              <SettingRow
                label="Install updates automatically"
                description={
                  !draft.auto
                    ? "Off. Gluon tells you when an update is ready and waits for you."
                    : draft.channel === "nightly" && draft.nightlyTiming === "asap"
                      ? "Each change is installed soon after it lands. If it doesn't come back healthy, the previous version is put back."
                      : `Installs around ${hourLabel(draft.hour, prefs.clock)}, at most once a day. If it doesn't come back healthy, the previous version is put back.`
                }
              >
                <Switch checked={draft.auto} onChange={(auto) => set({ auto })} aria-label="Install updates automatically" />
              </SettingRow>
              {draft.auto && draft.channel === "nightly" && (
                <SettingRow label="How soon">
                  <Segmented
                    aria-label="How soon nightly updates are installed"
                    value={draft.nightlyTiming}
                    onChange={(nightlyTiming) => set({ nightlyTiming })}
                    options={[
                      { value: "hour", label: "Once a day" },
                      { value: "asap", label: "As they land" },
                    ]}
                  />
                </SettingRow>
              )}
              {draft.auto && !(draft.channel === "nightly" && draft.nightlyTiming === "asap") && (
                <SettingRow label="Around" description="Pick an hour when nobody's watching a film.">
                  <Select
                    aria-label="Hour for automatic updates"
                    value={String(draft.hour)}
                    onChange={(v) => set({ hour: Number(v) })}
                    options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h, prefs.clock) }))}
                  />
                </SettingRow>
              )}
            </div>
          )}

          {saveError && (
            <p className={o.error} role="alert">
              {saveError}
            </p>
          )}
        </div>
      )}

      <Actions
        skip={data && !dev ? { label: "Skip for now", onClick: next } : undefined}
        primary={
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!data && !error}>
            {!data || dev ? "Continue" : "Save and continue"}
          </Button>
        }
      />
    </>
  );
}

/** Stable or Nightly, as two described choices (a radio group: arrows move, Space/Enter pick). */
export function ChannelChoice({ value, onChange }: { value: UpdateChannel; onChange: (v: UpdateChannel) => void }) {
  const group = React.useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      className={o.choices}
      role="radiogroup"
      aria-label="Which updates to follow"
      onKeyDown={(e) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        const i = CHANNELS.findIndex((c) => c.value === value);
        const nextI = (i + (e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1) + CHANNELS.length) % CHANNELS.length;
        const v = CHANNELS[nextI]!.value;
        onChange(v);
        group.current?.querySelector<HTMLElement>(`[data-value="${v}"]`)?.focus();
      }}
    >
      {CHANNELS.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={value === c.value} tabIndex={value === c.value ? 0 : -1} data-value={c.value} className={o.choice} onClick={() => onChange(c.value)}>
          <span className={o.radio} aria-hidden />
          <span className={o.choiceText}>
            <b>{c.title}</b>
            <span>{c.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
