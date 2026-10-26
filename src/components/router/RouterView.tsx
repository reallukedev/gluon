"use client";
import * as React from "react";
import type { RouterOverview } from "@/lib/router-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/Dialog";
import { Empty, Notice, Page, PageHeader } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { ConnectDialog, PortForwarding } from "@/components/network/PortForwarding";
import { DevicesPanel } from "./DevicesPanel";
import { FactsPanel, FirewallPanel, InternetPanel, TrafficPanel, WifiPanel } from "./Panels";
import { OVERVIEW_URL, mbps, since } from "./model";
import s from "./router.module.css";

const BACK = { href: "/network", label: "Network" };
const RESTART_URL = "/api/network/router/restart";
/** The page polls while it's open; the server reads the router more often while someone looks. */
const POLL_MS = 15_000;

function Summary({ o }: { o: RouterOverview }) {
  const model = o.facts?.model ?? "router";
  if (o.kind === "none") return <>Gluon can&rsquo;t find your router: this server has no default route.</>;
  if (o.kind === "unreachable") return <>Your router at <span className="mono">{o.gateway}</span> isn&rsquo;t answering Gluon.</>;
  if (o.kind === "other")
    return (
      <>
        Gluon can read AT&amp;T BGW gateways, and your router at <span className="mono">{o.gateway}</span>
        {o.otherName ? ` (${o.otherName})` : ""} isn&rsquo;t one. Set up the ports below on it by hand.
      </>
    );
  const bb = o.broadband;
  if (!bb) return <>Reading your {model}&hellip;</>;
  if (bb.up === false)
    return (
      <>
        <b>Your internet is down.</b> Your {model} says its {bb.source ? `${bb.source.toLowerCase()} ` : ""}connection to AT&amp;T is down. Devices at home can still reach each other and this server.
      </>
    );
  const line = [bb.source?.toLowerCase(), mbps(bb.lineMbps)].filter(Boolean).join(" at ");
  const online = o.devices ? o.devices.filter((d) => d.online).length : null;
  const boot = o.facts?.bootAt ?? null;
  const rest = [online !== null ? `${online} ${online === 1 ? "device is" : "devices are"} online` : null, boot ? `the router has been on for ${since(Date.now() - boot)}` : null].filter(Boolean).join(", and ");
  return (
    <>
      <b>Your internet is up</b>
      {line ? ` over ${line}` : ""}.{rest ? ` ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.` : ""}
    </>
  );
}

function RestartNotice({ o, onDismiss }: { o: RouterOverview; onDismiss: () => void }) {
  const fmt = useFormat();
  const r = o.restart;
  if (!r || Date.now() - r.requestedAt > 30 * 60_000) return null;
  if (r.state === "waiting")
    return (
      <Notice title="Restarting your router">
        Asked at {fmt.time(r.requestedAt)}. The internet and Wi-Fi are off for everyone at home until it&rsquo;s back, usually 3 to 5 minutes. Gluon checks every 15 seconds.
      </Notice>
    );
  return (
    <Notice
      tone={r.state === "failed" ? "fault" : "neutral"}
      title={r.state === "done" ? "Your router is back" : "Your router didn't come back as expected"}
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {r.message}
    </Notice>
  );
}

/** Network → Router: everything the home router says about the connection and the home network. */
export function RouterView({ initial }: { initial: RouterOverview | null }) {
  const fmt = useFormat();
  const [hidden, setHidden] = React.useState<number | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const waiting = (o: RouterOverview | undefined) => o?.restart?.state === "waiting";
  const { data, error, mutate } = useApi<RouterOverview>(OVERVIEW_URL, {
    fallbackData: initial ?? undefined,
    refreshInterval: (latest) => (waiting(latest) ? 5_000 : POLL_MS),
  });
  const o = data;

  const restart = () =>
    confirm({
      title: `Restart your ${o?.facts?.model ?? "router"}?`,
      consequences: [
        "The internet and Wi-Fi go off for everyone at home, usually for 3 to 5 minutes.",
        "Nothing outside can reach this server until the router is back. If you're away from home, this page goes quiet too.",
        "Settings, port forwards and Wi-Fi passwords stay as they are.",
      ],
      confirmLabel: "Restart the router",
      variant: "danger",
      onConfirm: async () => {
        setRestarting(true);
        try {
          await api.post(RESTART_URL, {});
          setHidden(null);
          await mutate();
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "reauth_cancelled")) throw e;
        } finally {
          setRestarting(false);
        }
      },
    });

  if (!o) {
    return (
      <Page>
        <PageHeader back={BACK} title="Router" summary={error ? "Gluon couldn't load what your router says." : "Reading your router…"} />
        {error && (
          <Notice tone="fault" title="Gluon didn't answer" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
            {error.message}
          </Notice>
        )}
      </Page>
    );
  }

  const bgw = o.kind === "bgw";
  const rejected = o.access.codeRejected;
  const actions = bgw ? (
    <div className={s.actions}>
      {o.access.connected && !rejected ? (
        <Button onClick={restart} loading={restarting} disabled={waiting(o)}>
          Restart the router
        </Button>
      ) : (
        <Button onClick={() => setConnecting(true)}>{rejected ? "Enter the access code again" : "Connect with the access code"}</Button>
      )}
    </div>
  ) : undefined;

  const by = o.access.connectedBy;
  const access = rejected ? (
    <StateLine state="attention" label="The router no longer accepts the access code Gluon has. Enter it again." />
  ) : o.access.connected ? (
    <div className={s.rowMain}>
      <StateLine state="running" label="Gluon has the access code" />
      {by && (
        <span className={s.rowSub}>
          Entered {by.name ? `by ${by.name} ` : ""}on {fmt.date(by.at, { year: true })}. It&rsquo;s saved for this server, so nobody else needs to enter it.
        </span>
      )}
    </div>
  ) : (
    <StateLine state="stopped" label="Gluon doesn't have the access code yet" />
  );

  return (
    <Page>
      <PageHeader back={BACK} title="Router" summary={<Summary o={o} />} actions={actions} />
      <div className={s.notices}>
        {o.restart && hidden !== o.restart.requestedAt && <RestartNotice o={o} onDismiss={() => setHidden(o.restart!.requestedAt)} />}
        {o.kind === "unreachable" && (
          <Notice tone="fault" title="Your router isn't answering">
            Gluon asks again every minute. If the internet is out too, check that the router&rsquo;s lights are on and this server&rsquo;s network cable is in.
          </Notice>
        )}
        {o.error && bgw && o.facts && !waiting(o) && (
          <Notice tone="attention" title="Gluon couldn't read the router just now">
            {o.error} {o.readAt.broadband ? <>What&rsquo;s below is from <Time ts={o.readAt.broadband} />.</> : null}
          </Notice>
        )}
        {error && o && <Notice tone="attention" title="Gluon isn't answering right now">What&rsquo;s below is the last reading. {error.message}</Notice>}
      </div>

      {o.kind === "none" ? (
        <Empty title="No router found">Gluon looks for the router through this server&rsquo;s default route. Check the server&rsquo;s network settings under System.</Empty>
      ) : bgw ? (
        <>
          <div className={s.grid}>
            <div className={s.col}>
              <InternetPanel o={o} />
              <TrafficPanel o={o} />
            </div>
            <div className={s.col}>
              <WifiPanel o={o} />
              <FirewallPanel o={o} />
              <FactsPanel o={o} access={access} />
            </div>
          </div>
          <div className={s.wide}>
            <DevicesPanel devices={o.devices} readAt={o.readAt.devices} loading={o.refreshing} />
          </div>
        </>
      ) : null}

      <div className={s.wide}>
        <PortForwarding onRouterPage />
      </div>
      {confirmNode}
      <ConnectDialog open={connecting} onOpenChange={setConnecting} model={o.facts?.model ?? "router"} gateway={o.gateway ?? ""} onConnected={() => void mutate()} />
    </Page>
  );
}
