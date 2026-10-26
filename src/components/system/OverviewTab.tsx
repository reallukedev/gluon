"use client";
import * as React from "react";
import type { RestartNeeded, SystemOverview } from "@/lib/system-types";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton, DefinitionList } from "@/components/ui/Surface";
import { useLive } from "@/lib/client/live";
import { Faceplate } from "./Faceplate";
import { Button, LinkButton } from "@/components/ui/Button";
import { SettingRow, Switch } from "@/components/ui/Field";
import { InlineEdit } from "@/components/ui/InlineEdit";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { TimezonePicker } from "./TimezonePicker";
import s from "./system.module.css";

export function OverviewTab({ initial }: { initial?: SystemOverview }) {
  const fmt = useFormat();
  const { data, error, isLoading, mutate } = useApi<SystemOverview>("/api/system/overview", { refresh: 30_000, fallbackData: initial });
  const restart = useApi<RestartNeeded>("/api/system/restart-needed", {
    refresh: 5 * 60_000,
  });

  if (!data) {
    if (error && !isLoading) {
      return (
        <Notice tone="fault" title="Couldn't read this machine's details" action={<Button onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      );
    }
    return <OverviewSkeleton />;
  }

  const hw = [data.hardware.vendor, data.hardware.product].filter(Boolean).join(" ");
  const osShort = data.os.name && data.os.versionFull ? `${data.os.name.replace(/ GNU\/Linux$/, "")} ${data.os.versionFull}` : data.os.prettyName;

  return (
    <div className={s.stack}>
      <RestartNotice overview={data} restart={restart.data} onRestarted={() => void restart.mutate()} />
      <Panel id="identity" className={s.identity}>
        <div className={s.identityRow}>
          <HostnameRow
            hostname={data.hostname}
            onRenamed={() => void mutate()}
            sub={[osShort, hw || null, data.virtualization && data.virtualization !== "none" ? `virtual machine (${data.virtualization})` : null].filter(Boolean).join(" · ")}
          />
          <div className={s.uptime}>
            <span className="label">Up for</span>
            <span className={`${s.uptimeFigure} num`}>{fmt.duration(data.uptimeSeconds)}</span>
            <span className={s.sub}>
              Since <Time ts={data.bootedAt} kind="dateTime" />
            </span>
          </div>
        </div>
      </Panel>
      <Panel title="Right now" meta={<LiveMeta />} flush>
        <Faceplate overview={data} />
      </Panel>
      <div className={s.grid}>
        <Panel title="Hardware and software">
          <DefinitionList items={identity(data)} />
        </Panel>
        <TimePanel overview={data} onChanged={() => void mutate()} />
      </div>
    </div>
  );
}

function LiveMeta() {
  const { status } = useLive();
  return <span className={s.liveMeta}>{status === "live" ? "Live" : status === "offline" ? "Paused, reconnecting" : "Connecting…"}</span>;
}

function identity(o: SystemOverview): [React.ReactNode, React.ReactNode][] {
  const rows: [React.ReactNode, React.ReactNode][] = [];
  rows.push([
    "System",
    <span key="os">
      {o.os.prettyName}
      {o.os.versionFull && !o.os.prettyName.includes(o.os.versionFull) ? `, version ${o.os.versionFull}` : ""}
    </span>,
  ]);
  rows.push([
    "Kernel",
    <span key="k" className="mono">
      {o.kernel.release}
    </span>,
  ]);
  if (o.cpu.model) {
    const cores = o.cpu.cores ? `${o.cpu.cores} cores, ${o.cpu.threads} threads` : `${o.cpu.threads} threads`;
    rows.push([
      "Processor",
      <span key="cpu" className={s.twoLine}>
        <span className={s.truncate} title={o.cpu.model}>
          {o.cpu.model}
        </span>
        <span className={s.sub}>
          {cores} · {o.architecture}
        </span>
      </span>,
    ]);
  } else
    rows.push([
      "Processor",
      <span key="cpu">
        {o.cpu.threads} threads · {o.architecture}
      </span>,
    ]);
  const hw = [o.hardware.vendor, o.hardware.product].filter(Boolean).join(" ");
  if (hw)
    rows.push([
      "Computer",
      <span key="hw">
        {hw}
        {o.hardware.chassis ? <span className={s.sub}> · {o.hardware.chassis}</span> : null}
      </span>,
    ]);
  const board = [o.hardware.boardVendor, o.hardware.board].filter(Boolean).join(" ");
  if (board && board !== hw)
    rows.push([
      "Board",
      <span key="b" className="mono">
        {board}
      </span>,
    ]);
  if (o.hardware.biosVersion)
    rows.push([
      "Firmware",
      <span key="fw">
        <span className="mono">{o.hardware.biosVersion}</span>
        {o.hardware.biosDate ? <span className={s.sub}> · {o.hardware.biosDate}</span> : null}
      </span>,
    ]);
  rows.push(["Runs on", o.virtualization && o.virtualization !== "none" ? `A virtual machine (${o.virtualization})` : "Real hardware"]);
  const versions = [o.docker && `Docker ${o.docker}`, o.umbrel, o.casaos && `CasaOS ${o.casaos}`, o.systemd && `systemd ${o.systemd}`].filter(Boolean) as string[];
  if (versions.length)
    rows.push([
      "Software",
      <span key="sw" className={s.sub2}>
        {versions.join(" · ")}
      </span>,
    ]);
  return rows;
}

// ---------------------------------------------------------------- hostname

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function hostnameProblem(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!name) return "Enter a name for the server.";
  if (name.length > 253) return "That name is too long.";
  for (const l of name.split(".")) {
    if (!l) return "A name can't have two dots in a row or start with a dot.";
    if (l.length > 63) return "Each part of the name can be 63 characters at most.";
    if (!LABEL.test(l)) return "Use only letters, digits and hyphens, and don't start or end with a hyphen.";
  }
  if (/^\d+$/.test(name.split(".")[0]!)) return "The name can't be only digits.";
  if (name === "localhost") return "Choose a name other than localhost.";
  return null;
}

function HostnameRow({ hostname, onRenamed, sub }: { hostname: string; onRenamed: () => void; sub?: string }) {
  const [confirm, confirmNode] = useConfirm();

  // The name edits in place; the consequences are confirmed before anything changes.
  function save(raw: string) {
    const next = raw.trim().toLowerCase().replace(/\.$/, "");
    if (next === hostname) return;
    confirm({
      title: `Rename the server to ${next}?`,
      consequences: [
        `Other computers find it as ${next}.local instead of ${hostname}.local. Bookmarks using the old name stop working.`,
        "Samba and other apps that show the name pick it up after they restart.",
        "Apps and files aren't affected.",
      ],
      confirmLabel: "Rename",
      variant: "primary",
      onConfirm: async () => {
        try {
          const r = await api.put<{ hostname: string; message: string }>("/api/system/hostname", { hostname: next });
          toast.success(`The server is now called ${r.hostname}`, {
            description: "Apps pick up the new name after they restart.",
          });
          onRenamed();
        } catch (err) {
          if (err instanceof ApiError && err.code === "reauth_cancelled") return;
          throw err;
        }
      },
    });
  }

  return (
    <div className={s.hostText}>
      <InlineEdit value={hostname} label="Server name" className={s.hostName} validate={hostnameProblem} maxLength={253} mono={false} onSave={save} />
      {sub && <span className={s.hostSub}>{sub}</span>}
      {confirmNode}
    </div>
  );
}

// ---------------------------------------------------------------- time

function TimePanel({ overview, onChanged }: { overview: SystemOverview; onChanged: () => void }) {
  const t = overview.time;
  const [busy, setBusy] = React.useState<"tz" | "ntp" | null>(null);

  async function put(body: { timezone?: string; ntp?: boolean }, what: "tz" | "ntp") {
    setBusy(what);
    try {
      await api.put("/api/system/time", body);
      toast.success(body.timezone ? `Timezone set to ${body.timezone.replace(/_/g, " ")}` : body.ntp ? "Automatic time is on" : "Automatic time is off");
      onChanged();
    } catch (e) {
      toast.error(what === "tz" ? "Couldn't change the timezone" : "Couldn't change automatic time", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  const syncText =
    t.ntp === false
      ? "Off. The clock may drift."
      : t.synced
        ? `In sync${t.server ? ` with ${t.server}` : ""}.`
        : t.ntp
          ? "On, but not in sync yet. Check the internet connection if this lasts."
          : "Unknown";

  return (
    <Panel title="Time" id="time">
      <SettingRow label="Timezone" description="Used for scheduled restarts, logs and apps that follow the server's clock." stack>
        <TimezonePicker value={t.timezone} disabled={busy === "tz"} onChange={(tz) => void put({ timezone: tz }, "tz")} />
      </SettingRow>
      <SettingRow label="Set time automatically" description={syncText}>
        <Switch checked={!!t.ntp} disabled={busy === "ntp" || t.canNtp === false} onChange={(v) => void put({ ntp: v }, "ntp")} aria-label="Set time automatically" />
      </SettingRow>
    </Panel>
  );
}

// ---------------------------------------------------------------- restart needed

function RestartNotice({ overview, restart, onRestarted }: { overview: SystemOverview; restart?: RestartNeeded; onRestarted: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const reboot = restart?.reboot ?? overview.reboot;
  const services = restart?.services ?? [];
  if (!reboot.required && services.length === 0) return null;

  async function restartUnit(unit: string, name: string) {
    setBusy(unit);
    try {
      const r = await api.post<{ message: string }>(`/api/system/services/${encodeURIComponent(unit)}`, { action: "restart" });
      toast.success(r.message);
      onRestarted();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled"))
        toast.error(`Couldn't restart ${name}`, {
          description: e instanceof Error ? e.message : undefined,
        });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {reboot.required && (
        <Notice tone="attention" title="The server needs a restart to finish updating" action={<LinkButton href="/system?tab=power">Restart…</LinkButton>}>
          {reboot.reasons.join(" ")}
        </Notice>
      )}
      {services.length > 0 && (
        <Panel
          title="Still running old code"
          meta={
            <span>
              {services.length === 1 ? "1 service" : `${services.length} services`} · checked <Time ts={restart!.checkedAt} />
            </span>
          }
          flush
        >
          <p className={s.panelLead}>These were updated but keep using the old version until they restart. Restarting takes a few seconds each.</p>
          <ul className={s.plainList}>
            {services.map((x) => (
              <li key={x.unit}>
                <span className={s.twoLine}>
                  <span className={s.truncate}>{x.name}</span>
                  <span className={`${s.sub} mono ${s.truncate}`} title={x.libraries.join(", ")}>
                    {x.unit}
                    {x.libraries.length ? ` · ${x.libraries.slice(0, 3).join(", ")}${x.libraries.length > 3 ? "…" : ""}` : ""}
                  </span>
                </span>
                {/^(docker|containerd)\.service$/.test(x.unit) ? (
                  <LinkButton size="sm" href={`/system?tab=services&unit=${encodeURIComponent(x.unit)}`}>
                    Open
                  </LinkButton>
                ) : (
                  <Button
                    size="sm"
                    loading={busy === x.unit}
                    onClick={() =>
                      x.important
                        ? confirm({
                            title: `Restart ${x.name}?`,
                            consequences: [`${x.name} is unavailable for a few seconds while it restarts.`],
                            confirmLabel: `Restart ${x.name}`,
                            variant: "primary",
                            onConfirm: () => restartUnit(x.unit, x.name),
                          })
                        : void restartUnit(x.unit, x.name)
                    }
                  >
                    Restart
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {restart?.other.length ? (
            <p className={s.panelFoot}>
              {restart.other.length === 1 ? "1 other program" : `${restart.other.length} other programs`} (like login sessions) also use old files. A server restart clears them.
            </p>
          ) : null}
        </Panel>
      )}
      {confirmNode}
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className={s.stack} aria-busy>
      <Panel className={s.identity}>
        <div className={s.identityRow}>
          <div className={s.skelRows} style={{ flex: 1 }}>
            <Skeleton height={30} width={180} />
            <Skeleton height={14} width="40%" />
          </div>
          <Skeleton height={44} width={120} />
        </div>
      </Panel>
      <Panel title="Right now">
        <Skeleton height={150} radius={8} />
      </Panel>
    </div>
  );
}
