"use client";
import * as React from "react";
import { Play, Plus } from "iconoir-react";
import type { VoiceDetails, VoiceLive } from "@/server/voice/types";
import { api, useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { people, voiceUrl } from "./client";
import { People } from "./People";
import { Channels, ChannelDialog, type ChannelEdit } from "./Channels";
import { Registered } from "./Registered";
import { VoiceSettings } from "./VoiceSettings";
import { Certificate } from "./Certificate";
import { ManageDialog, NotManaged } from "./Manage";
import s from "./voice.module.css";

/**
 * Apps → Mumble → Voice server: who's connected and where, the channel tree, registered people,
 * the server's settings and its certificate, all read live from Mumble over its admin connection
 * (Ice). Until Gluon can reach that connection it shows what Docker can tell, and the one-time
 * change that opens it.
 */
export function VoicePanel({ appId, appName, running }: { appId: string; appName: string; running: boolean }) {
  const { data, error, mutate } = useApi<VoiceLive>(voiceUrl(appId), { refresh: running ? 4000 : 15_000 });
  const managed = !!data?.managed;
  const details = useApi<VoiceDetails>(data ? voiceUrl(appId, "/details") : null, { refresh: managed ? 30_000 : 0 });
  const [managing, setManaging] = React.useState(false);
  const [channelEdit, setChannelEdit] = React.useState<ChannelEdit | null>(null);
  const [starting, setStarting] = React.useState(false);

  const refresh = React.useCallback(() => {
    void mutate();
    void details.mutate();
  }, [mutate, details]);

  async function start() {
    setStarting(true);
    try {
      const r = await api.post<{ message?: string }>(`/api/apps/${encodeURIComponent(appId)}/action`, { action: "start" });
      toast.success(r.message ?? `Started ${appName}`);
      refresh();
    } catch (e) {
      toast.error(`Couldn't start ${appName}`, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setStarting(false);
    }
  }

  if (error && !data) {
    return (
      <Notice tone="fault" title="Gluon couldn't read this voice server" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
        {error.message}
      </Notice>
    );
  }
  if (!data) return <VoiceSkeleton />;

  if (!data.running) {
    return (
      <div className={s.panel}>
        <Lead live={data} />
        <Panel flush>
          <div className={s.empty}>
            <p>Start {appName} to see who&rsquo;s here and change its channels, people and settings.</p>
            <Button variant="primary" icon={<Play />} loading={starting} onClick={() => void start()}>
              Start {appName}
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const rootName = details.data?.settings.find((x) => x.key === "registername")?.value || null;
  // Mounted in both states, so the dialog stays open to show how the change ended.
  const manageDialog = <ManageDialog open={managing} onOpenChange={setManaging} appId={appId} appName={appName} onDone={refresh} />;

  if (!data.managed) {
    return (
      <>
        <div className={s.panel}>
          <Lead live={data} />
          <NotManaged live={data} details={details.data ?? null} onManage={() => setManaging(true)} onRetry={refresh} />
        </div>
        {manageDialog}
      </>
    );
  }

  return (
    <>
      <div className={s.panel}>
        <Lead live={data} actions={<Button icon={<Plus />} onClick={() => setChannelEdit({ kind: "create", parent: 0 })}>New channel</Button>} />
        {data.server && data.server.others > 0 && (
          <Notice title={`Mumble runs ${data.server.others + 1} servers here`}>Gluon shows and changes the first one (server {data.server.id}). Manage the others from a Mumble app signed in as SuperUser.</Notice>
        )}
        <div className={s.pair}>
          <People appId={appId} live={data} rootName={rootName} onChanged={refresh} />
          <Channels appId={appId} live={data} rootName={rootName} onEdit={setChannelEdit} onChanged={refresh} />
        </div>
        <Registered appId={appId} details={details.data ?? null} onChanged={refresh} />
        <VoiceSettings appId={appId} appName={appName} details={details.data ?? null} connected={data.users.length} via={data.manage.via} onChanged={refresh} />
        <Certificate appId={appId} details={details.data ?? null} onChanged={refresh} />
        <ChannelDialog appId={appId} live={data} edit={channelEdit} onClose={() => setChannelEdit(null)} onChanged={refresh} />
      </div>
      {manageDialog}
    </>
  );
}

/** Address, one sentence of state, and the facts underneath. */
function Lead({ live, actions }: { live: VoiceLive; actions?: React.ReactNode }) {
  const n = live.users.length;
  const inChannels = new Set(live.users.map((u) => u.channel)).size;
  let sentence: React.ReactNode;
  if (!live.running) sentence = "Stopped. Nobody can connect.";
  else if (live.managed) {
    sentence = (
      <>
        <b>{n === 0 ? "Nobody is here right now." : `${people(n)} in ${inChannels === 1 ? "1 channel" : `${inChannels} channels`}.`}</b> {live.server ? `Version ${live.server.version}.` : ""}{" "}
        {live.basics.passwordSet ? "Joining needs the password." : "Anyone with the address can join."}
      </>
    );
  } else {
    const c = live.basics.connected;
    sentence = (
      <>
        <b>{c === null ? "Running." : c === 0 ? "Running, nobody connected." : `Running, ${people(c)} connected.`}</b>
        {live.container?.version ? ` Version ${live.container.version}.` : ""}
      </>
    );
  }
  const addr = live.address;
  return (
    <div className={s.lead}>
      <div className={s.leadText}>
        {addr && (
          <p className={s.address}>
            <span className={s.addressText}>
              {addr.host}
              <span className={s.port}>:{addr.port}</span>
            </span>
            <CopyButton value={`${addr.host}:${addr.port}`} label="Copy address" variant="ghost" />

          </p>
        )}
        <p className={s.sentence}>{sentence}</p>
        <p className={s.facts}>
          {live.running && live.container?.startedAt && (
            <span>
              Running since <Time ts={live.container.startedAt} />
            </span>
          )}
          {live.managed && live.basics.maxUsers && <span>Room for {live.basics.maxUsers.toLocaleString()}</span>}
          {live.container && <span className="mono">{live.container.name}</span>}
        </p>
      </div>
      {actions && (
        <div className={s.leadActions}>
          {actions}
        </div>
      )}
    </div>
  );
}

function VoiceSkeleton() {
  return (
    <div className={s.panel} aria-busy="true" aria-label="Loading the voice server">
      <div className={s.leadText}>
        <Skeleton width={260} height={24} />
        <Skeleton width="min(520px, 90%)" height={16} />
        <Skeleton width={220} height={12} />
      </div>
      <div className={s.pair}>
        <Skeleton height={260} radius={12} />
        <Skeleton height={260} radius={12} />
      </div>
      <Skeleton height={180} radius={12} />
    </div>
  );
}
