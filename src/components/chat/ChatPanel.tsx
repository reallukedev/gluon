"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { UserPlus, Link as LinkIcon } from "iconoir-react";
import type { ChatSnapshot } from "@/lib/chat-types";
import type { NetworkStatus } from "@/lib/network-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button, LinkButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { Accounts, AddAccountDialog } from "./Accounts";
import { Invites, InviteDialog } from "./Invites";
import { Capabilities } from "./Capabilities";
import { ChatSettingsForm, useSettingsSaver } from "./ChatSettingsForm";
import { Rooms } from "./Rooms";
import s from "./chat.module.css";

const CallsDialog = dynamic(() => import("./Calls").then((m) => m.CallsDialog), { ssr: false });
const ConfigEditor = dynamic(() => import("./ConfigEditor").then((m) => m.ConfigEditor), {
  ssr: false,
  loading: () => <Skeleton height={360} radius={12} />,
});

/**
 * Apps → Prosody → Chat server: who has an account and which devices they're on, invite links,
 * what chat apps can do with this server (and the switch that fixes each gap), group chats,
 * settings and the config file. Everything is read live from Prosody.
 */
export function ChatPanel({ appId, appName, running }: { appId: string; appName: string; running: boolean }) {
  const url = running ? `/api/chat/${encodeURIComponent(appId)}` : null;
  const { data, error, mutate, isLoading } = useApi<ChatSnapshot>(url, { refresh: 15_000 });
  const [hostPick, setHostPick] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [showConfig, setShowConfig] = React.useState(false);

  if (!running) {
    return (
      <Panel>
        <div className={s.empty}>
          <p>{appName} isn&rsquo;t running, so Gluon can&rsquo;t read its accounts or settings. Start it from the top of this page.</p>
        </div>
      </Panel>
    );
  }
  if (error && !data) {
    // prosodyctl reads the whole config first, so a mistake in it takes the console down too.
    const brokenConfig = /config file/i.test(error.message);
    return (
      <div className={s.panel}>
        <Notice tone="fault" title={brokenConfig ? "Prosody can't read its config" : "Gluon couldn't talk to Prosody"} action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
          {brokenConfig ? " Prosody keeps running on the config it last read; fix the file below and save it." : ""}
        </Notice>
        {brokenConfig && (
          <Panel title="Prosody's config file" flush>
            <ConfigEditor appId={appId} onSaved={() => void mutate()} />
          </Panel>
        )}
      </div>
    );
  }
  if (!data || isLoading) return <ChatSkeleton />;

  const host = data.hosts.find((h) => h.host === hostPick) ?? data.hosts[0];
  if (!host) {
    return (
      <Notice title="Prosody has no chat domain yet">
        Add a VirtualHost line to its config file (like <span className="mono">VirtualHost &quot;chat.example.com&quot;</span>), then restart it.
      </Notice>
    );
  }

  return (
    <div className={s.panel}>
      <Lead snap={data} hostName={host.host} onAdd={() => setAdding(true)} onInvite={() => setInviting(true)} />
      {data.hosts.length > 1 && (
        <Segmented aria-label="Chat domain" value={host.host} onChange={setHostPick} options={data.hosts.map((h) => ({ value: h.host, label: h.host }))} />
      )}
      <ConfigNotice snap={data} />
      {host.problem && (
        <Notice tone="fault" title={`Prosody couldn't read ${host.host}`}>
          {host.problem} Its log under Logs has the details.
        </Notice>
      )}
      <ReachNotice host={host.host} />

      <Accounts appId={appId} host={host} onChanged={() => void mutate()} onAdd={() => setAdding(true)} />
      <Invites appId={appId} host={host} onChanged={() => void mutate()} onInvite={() => setInviting(true)} />
      <ChatSettingsArea appId={appId} snap={data} hostName={host.host} onSaved={() => void mutate()} />
      {host.groupsHost && <Rooms appId={appId} host={host} onChanged={() => void mutate()} />}

      <Panel
        title="Prosody's config file"
        meta={
          <Button size="sm" variant="ghost" onClick={() => setShowConfig((v) => !v)} aria-expanded={showConfig}>
            {showConfig ? "Hide" : "Edit by hand"}
          </Button>
        }
        flush
      >
        {showConfig ? (
          <ConfigEditor appId={appId} onSaved={() => void mutate()} />
        ) : (
          <p className={s.hint} style={{ padding: "14px 18px" }}>
            For settings Gluon doesn&rsquo;t cover. Gluon checks your changes with Prosody before it saves them, and keeps a copy of the file from before it first changed anything.
          </p>
        )}
      </Panel>

      <AddAccountDialog open={adding} onOpenChange={setAdding} appId={appId} host={host.host} onCreated={() => void mutate()} />
      <InviteDialog open={inviting} onOpenChange={setInviting} appId={appId} host={host} onCreated={() => void mutate()} />
    </div>
  );
}

function Lead({ snap, hostName, onAdd, onInvite }: { snap: ChatSnapshot; hostName: string; onAdd: () => void; onInvite: () => void }) {
  const fmt = useFormat();
  const host = snap.hosts.find((h) => h.host === hostName)!;
  const online = host.accounts.filter((a) => a.devices.length > 0).length;
  const accounts = host.accounts.length;
  const signUp = host.settings.signUp === "closed" ? "Only you add people" : host.settings.signUp === "invite" ? "You and your members invite people" : "Anyone can sign up";
  const gaps = host.capabilities.filter((c) => !c.on && c.fix).length;
  return (
    <div className={s.lead}>
      <div className={s.leadText}>
        <p className={s.domain}>
          <span className={s.at}>you@</span>
          {host.host}
        </p>
        <p className={s.sentence}>
          {accounts === 0 ? "No accounts yet." : `${fmt.plural(accounts, "account")}, ${online === 0 ? "nobody online right now" : `${online} online now`}.`} {signUp}.
          {gaps > 0 ? ` ${gaps === 1 ? "One thing chat apps expect is" : `${gaps} things chat apps expect are`} turned off.` : ""}
        </p>
        <p className={s.facts}>
          <span>Prosody {snap.version.split(" ")[0]}</span>
          {snap.startedAt && (
            <span>
              Running since <Time ts={snap.startedAt} />
            </span>
          )}
          <span className="mono">{snap.container}</span>
        </p>
      </div>
      <div className={s.leadActions}>
        <Button icon={<LinkIcon />} onClick={onInvite} disabled={!host.invitesReady} title={host.invitesReady ? undefined : "Turn on invite links in Settings below"}>
          Invite someone
        </Button>
        <Button variant="primary" icon={<UserPlus />} onClick={onAdd}>
          Add account
        </Button>
      </div>
    </div>
  );
}

/**
 * Network's check of the router, where it matters most: a chat server that works at home but not
 * from outside looks fine from every device on the home network.
 */
function ReachNotice({ host }: { host: string }) {
  const { data } = useApi<NetworkStatus>("/api/network/status", { refresh: 60_000 });
  const route = data?.routes.find((r) => r.xmpp?.domain === host);
  const reach = route?.xmpp?.reach;
  if (!route || !reach || reach.state !== "blocked") return null;
  const blocked = reach.ports.filter((p) => p.verdict === "not-forwarded");
  const signIn = blocked.some((p) => p.primary);
  return (
    <Notice
      tone={signIn ? "fault" : "attention"}
      title={signIn ? "People outside your home can't sign in" : "Other chat servers can't reach this one"}
      action={
        <LinkButton size="sm" href={`/network?route=${encodeURIComponent(route.id)}`}>
          See the check
        </LinkButton>
      }
    >
      {blocked.length ? blocked.map((p) => p.message).join(" ") : reach.summary}
    </Notice>
  );
}

function ConfigNotice({ snap }: { snap: ChatSnapshot }) {
  if (snap.major !== null && snap.major < 13) {
    return (
      <Notice tone="attention" title={`This is Prosody ${snap.version}`}>
        Accounts work, but Gluon only changes settings on Prosody 13 and newer. Update the app to manage everything here.
      </Notice>
    );
  }
  if (snap.hosts.length > 1) {
    return (
      <Notice title="Settings for several chat domains live in the config file">
        This Prosody serves {snap.hosts.length} chat domains, and Gluon&rsquo;s settings would apply to all of them at once. Accounts, invites and group chats still work here for each one; change settings under Prosody&rsquo;s config file below.
      </Notice>
    );
  }
  if (!snap.config.writable) {
    return (
      <Notice tone="attention" title="Gluon can't change Prosody's settings">
        {snap.config.reason ?? "Its config file isn't where Gluon can reach it."} Accounts, invites and group chats still work.
      </Notice>
    );
  }
  return null;
}

function ChatSettingsArea({ appId, snap, hostName, onSaved }: { appId: string; snap: ChatSnapshot; hostName: string; onSaved: () => void }) {
  const host = snap.hosts.find((h) => h.host === hostName)!;
  const [calls, setCalls] = React.useState(false);
  const saver = useSettingsSaver(appId, host, snap.config.rev, onSaved);
  // One gluon.cfg.lua can't hold different settings per domain, so several domains are hand-edited.
  const canEdit = snap.config.writable && (snap.major === null || snap.major >= 13) && snap.hosts.length === 1;
  return (
    <>
      <Capabilities host={host} canFix={canEdit} saving={saver.saving} onFix={(patch) => void saver.save({ ...host.settings, ...patch })} onCalls={() => setCalls(true)} />
      <ChatSettingsForm key={`${appId}:${hostName}:${JSON.stringify(host.settings)}`} host={host} disabled={!canEdit} saver={saver} multipleHosts={snap.hosts.length > 1} onCalls={() => setCalls(true)} />
      {saver.node}
      {calls && <CallsDialog open={calls} onOpenChange={setCalls} appId={appId} onChanged={onSaved} />}
    </>
  );
}

function ChatSkeleton() {
  return (
    <div className={s.panel} aria-busy="true" aria-label="Loading the chat server">
      <div className={s.lead}>
        <div className={s.leadText}>
          <Skeleton width={260} height={24} />
          <Skeleton width="70%" height={14} />
          <Skeleton width={220} height={12} />
        </div>
        <div className={s.leadActions}>
          <Skeleton width={136} height={34} radius={8} />
          <Skeleton width={128} height={34} radius={8} />
        </div>
      </div>
      <Skeleton height={190} radius={12} />
      <Skeleton height={120} radius={12} />
      <Skeleton height={300} radius={12} />
    </div>
  );
}
