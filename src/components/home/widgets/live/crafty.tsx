"use client";
// Crafty Controller: every game server, who's on, and Start, Stop and Restart for admins. After a command the row
// follows the server until Crafty reports it got there, and says so plainly when it doesn't.
import * as React from "react";
import { mutate } from "swr";
import { MoreHoriz } from "iconoir-react";
import type { WidgetProps } from "../../types";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { api, ApiError } from "@/lib/client/api";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import type { CraftyAction, CraftyServer, CraftyServerResult, CraftyServersData, IntegrationRef } from "@/lib/widgets-types";
import type { LineState } from "@/lib/types";
import { Gate, Quiet, RowsSkeleton, useIntegrationWidget, WidgetState } from "./shared";
import { clock, pollDelay, settle, type Pending, type Verdict } from "./crafty-progress";
import { useSmartUrl } from "../core";
import { spanWords, useFit } from "../kit";
import type { IntegrationConfig } from "./media";
import l from "./live.module.css";
import c from "./crafty.module.css";

const ING: Record<CraftyAction, string> = { start: "Starting", stop: "Stopping", restart: "Restarting", kill: "Force-stopping" };

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Steve, Alex and notch", "Steve, Alex and 4 more". */
function names(p: NonNullable<CraftyServer["players"]>, max = 3): string {
  const shown = p.names.slice(0, max);
  const rest = Math.max(p.online - shown.length, 0);
  if (!shown.length) return "";
  if (!rest) return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `${shown.join(", ")} and ${rest} more`;
}

/** The sentence over the list: how many are up and how many people are on. */
function summary(list: CraftyServer[]): string {
  const up = list.filter((s) => s.state === "running").length;
  const coming = list.filter((s) => s.line === "starting").length;
  const playing = list.reduce((n, s) => n + (s.players?.online ?? 0), 0);
  const broken = list.filter((s) => s.state === "crashed" || s.state === "unresponsive");
  if (broken.length === 1) return `${broken[0]!.name} ${broken[0]!.state === "crashed" ? "crashed" : "isn't answering"}.`;
  if (broken.length > 1) return `${broken.length} servers need a look.`;
  if (!up && !coming) return `All ${list.length} are stopped.`;
  const parts = [up === list.length ? `All ${list.length} running` : `${up} of ${list.length} running`];
  if (coming) parts.push(`${coming} starting`);
  if (playing) parts.push(`${plural(playing, "person", "people")} playing`);
  else if (up && !coming) parts.push("nobody playing");
  return parts.join(" · ");
}

/**
 * Up (or coming up, or in trouble) first, then stopped, by name within each. While a command settles the rows
 * keep the order they had, so the one being pressed never slides away.
 */
function ordered(list: CraftyServer[], keep: string[] | null): CraftyServer[] {
  if (keep?.length) {
    const at = new Map(keep.map((id, i) => [id, i]));
    return [...list].sort((a, b) => (at.get(a.id) ?? 1e6) - (at.get(b.id) ?? 1e6) || a.name.localeCompare(b.name));
  }
  const rank = (s: CraftyServer) => (s.line === "stopped" ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function useTick(ms: number) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

interface Tracked extends Pending {
  /** Never "done": a settled command stops being tracked. */
  verdict: Exclude<Verdict, { kind: "done" }>;
  /** Still being followed. False once the back-off gives up: the message stays, the row shows the widget's data. */
  watching: boolean;
  /** Latest answer while following it. */
  server: CraftyServer | null;
}

type Settled = { server: CraftyServer; at: number };
interface Commands {
  tracked: Record<string, Tracked>;
  settled: Record<string, Settled>;
}

/**
 * Commands and their progress for one Crafty connection, shared by every Minecraft servers widget on the page so
 * two of them never disagree. While any command is unsettled the store polls each such server through Gluon every
 * two seconds; once one settles its row keeps that answer until the widget's own data is at least as new.
 */
class CommandStore {
  state: Commands = { tracked: {}, settled: {} };
  private listeners = new Set<() => void>();
  /** One pending poll per server, each on its own back-off (pollDelay). */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private hidden = false;
  constructor(private readonly integration: string) {}

  subscribe = (fn: () => void) => {
    if (!this.listeners.size && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      this.hidden = document.hidden;
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.clearTimers();
      }
    };
  };
  snapshot = () => this.state;

  // A hidden tab asks Crafty nothing; coming back asks once straight away, then carries on with the back-off.
  private onVisibility = () => {
    this.hidden = document.hidden;
    if (this.hidden) return this.clearTimers();
    for (const id of Object.keys(this.state.tracked)) this.schedule(id, 0);
  };
  private clearTimers() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private set(next: Partial<Commands>) {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }
  private patch(id: string, fn: (t: Tracked) => Tracked) {
    const cur = this.state.tracked[id];
    if (cur) this.set({ tracked: { ...this.state.tracked, [id]: fn(cur) } });
  }
  private drop(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const { [id]: _gone, ...rest } = this.state.tracked;
    this.set({ tracked: rest });
  }

  /** Ask about one server after `delay` (default: its back-off). Stops for good when the back-off says so. */
  private schedule(id: string, delay?: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const t = this.state.tracked[id];
    if (!t || this.hidden || !this.listeners.size) return;
    const next = delay ?? pollDelay(t, t.verdict, Date.now());
    if (next === null) {
      if (t.watching) this.patch(id, (x) => ({ ...x, watching: false }));
      return;
    }
    this.timers.set(
      id,
      setTimeout(() => void this.poll(id), next),
    );
  }

  private async poll(id: string) {
    this.timers.delete(id);
    const p = this.state.tracked[id];
    if (!p) return;
    try {
      const r = await api.get<CraftyServerResult>(`/api/integrations/${encodeURIComponent(this.integration)}/crafty?server=${encodeURIComponent(id)}`);
      if (!r.server || this.state.tracked[id]?.since !== p.since) return;
      const v = settle(p, r.server, Date.now());
      if (v.kind === "done") {
        const { [id]: _gone, ...rest } = this.state.tracked;
        this.set({ tracked: rest, settled: { ...this.state.settled, [id]: { server: r.server, at: Date.now() } } });
        void refreshWidgets(this.integration);
        return;
      }
      this.patch(id, (t) => ({ ...t, server: r.server, verdict: v }));
    } catch {
      // A missed poll is fine: Crafty may be busy. The time limits still apply.
    }
    if (this.state.tracked[id]?.since === p.since) this.schedule(id);
  }

  /** Send a command. Throws (with Crafty's or Gluon's reason) so a confirmation dialog can show it. */
  run = async (s: CraftyServer, action: CraftyAction) => {
    const since = Date.now();
    this.set({ tracked: { ...this.state.tracked, [s.id]: { action, since, run: s.run, verdict: { kind: "wait" }, server: null, watching: true } } });
    try {
      const r = await api.post<CraftyServerResult>(`/api/integrations/${encodeURIComponent(this.integration)}/crafty`, { server: s.id, action });
      if (r.server && this.state.tracked[s.id]?.since === since) this.patch(s.id, (t) => ({ ...t, server: r.server }));
    } catch (e) {
      if (this.state.tracked[s.id]?.since === since) this.drop(s.id);
      throw e;
    }
    if (this.state.tracked[s.id]?.since === since) this.schedule(s.id);
  };

  dismiss = (id: string) => this.drop(id);
}

const stores = new Map<string, CommandStore>();
const storeFor = (integration: string) => {
  let st = stores.get(integration);
  if (!st) stores.set(integration, (st = new CommandStore(integration)));
  return st;
};
const EMPTY: Commands = { tracked: {}, settled: {} };
const noop = () => () => {};

/** Every Minecraft servers widget reading this connection fetches again. */
function refreshWidgets(integration: string) {
  return mutate((key) => Array.isArray(key) && key[0] === "widget" && key[1] === "crafty.servers" && key[2] === integration);
}

function useCommands(integration: string | null) {
  const store = integration ? storeFor(integration) : null;
  const state = React.useSyncExternalStore(store?.subscribe ?? noop, store?.snapshot ?? (() => EMPTY), () => EMPTY);
  return { ...state, run: store?.run, dismiss: store?.dismiss };
}

function Meta({ s, wide, now }: { s: CraftyServer; wide: boolean; now: number }) {
  const fmt = useFormat();
  const bits: React.ReactNode[] = [];
  const game = s.game !== "Minecraft" ? `${s.game} · ` : "";
  switch (s.state) {
    case "running":
      bits.push(s.players ? (s.players.online ? `${s.players.online} of ${s.players.max} playing` : "Nobody playing") : "Running");
      break;
    case "starting":
      bits.push("Starting");
      break;
    case "waiting":
      bits.push("Waiting to start");
      break;
    case "updating":
      bits.push("Updating");
      break;
    case "importing":
      bits.push("Importing");
      break;
    case "crashed":
      bits.push(<span className={l.faultText}>Crashed</span>);
      break;
    case "unresponsive":
      bits.push(<span className={l.faultText}>Running, not answering</span>);
      break;
    case "unknown":
      bits.push("No word from Crafty yet");
      break;
    default:
      bits.push("Stopped");
  }
  if (s.version) bits.push(s.version);
  if (s.state === "running" && s.startedAt) bits.push(`up ${spanWords(now - s.startedAt)}`);
  // CPU and memory only where there's room for them (hidden again by CSS when the widget is narrow).
  const extras: string[] = [];
  if (wide && s.running && s.cpu !== null) extras.push(`CPU ${Math.round(s.cpu)}%`);
  if (wide && s.running && s.memory) extras.push(fmt.bytes(s.memory, 1));
  return (
    <span className={`${c.meta} num`}>
      {game}
      {bits.map((b, i) => (
        <React.Fragment key={i}>
          {i > 0 ? " · " : null}
          {b}
        </React.Fragment>
      ))}
      {extras.length ? <span className={c.extra}> · {extras.join(" · ")}</span> : null}
    </span>
  );
}

interface RowProps {
  s: CraftyServer;
  t: Tracked | undefined;
  admin: boolean;
  /** Commands are off while the shown state may be old (Crafty not answering). */
  live: boolean;
  wide: boolean;
  tall: boolean;
  /** The only server: room to name everyone who's on. */
  solo: boolean;
  /** Doesn't fit the widget: kept in the layout (so it can be measured) but not shown or reachable. */
  hidden?: boolean;
  now: number;
  href: string | null;
  onCommand: (s: CraftyServer, a: CraftyAction) => void;
  onDismiss: (id: string) => void;
}

function ServerRow({ s, t, admin, live, wide, tall, solo, hidden, now, href, onCommand, onDismiss }: RowProps) {
  const { prefs } = usePrefs();
  const pending = !!t?.watching;
  const line: LineState = t ? (t.verdict.kind === "failed" ? "unhealthy" : t.verdict.kind === "slow" ? "attention" : "starting") : s.line;
  const who = s.players && s.players.online ? names(s.players, solo ? 12 : wide ? 6 : 3) : "";
  const playersTitle = s.players?.names.length ? s.players.names.join(", ") : undefined;

  let status: React.ReactNode;
  if (t) {
    const took = clock(now - t.since);
    status =
      t.verdict.kind === "wait" && !t.watching ? (
        <span className={c.note}>Gluon stopped checking after 10 minutes. This shows what Crafty last reported.</span>
      ) : t.verdict.kind === "wait" ? (
        <span className={`${c.meta} num`}>
          {ING[t.action]}
          {/* The clock ticks every second; screen readers hear only the step. */}
          <span aria-hidden> · {took}</span>
        </span>
      ) : (
        <span className={c.note} data-tone={t.verdict.kind === "failed" ? "fault" : undefined}>
          {t.verdict.message}
        </span>
      );
  } else {
    status = <Meta s={s} wide={wide} now={now} />;
  }

  // What a person can do from here. While a command settles only its remedy is offered.
  const actions: { label: string; action: CraftyAction; primary?: boolean }[] = [];
  if (admin && live) {
    if (t) {
      if (t.verdict.kind === "slow" && t.action === "stop") actions.push({ label: "Force-stop", action: "kill" });
    } else if (!s.running && s.state !== "updating" && s.state !== "importing") {
      actions.push({ label: "Start", action: "start", primary: true });
    } else if (s.running && s.state !== "updating" && s.state !== "importing") {
      actions.push({ label: "Restart", action: "restart" }, { label: "Stop", action: "stop" });
    }
  }
  const open = href ? { label: "Open in Crafty", href } : null;
  const menu: MenuEntry[] = [
    ...actions.map((a) => ({ label: a.label, danger: a.action === "kill", onSelect: () => onCommand(s, a.action) })),
    ...(open ? [...(actions.length ? (["separator"] as const) : []), { label: open.label, href: open.href }] : []),
  ];

  return (
    <li className={c.row} aria-busy={pending || undefined} aria-hidden={hidden || undefined}>
      <StateLine state={line} size={14} className={c.glyph} />
      <span className={c.text}>
        {href ? (
          <a className={`${c.name} ${c.nameLink}`} href={href} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer" title={`${s.name}: open in Crafty`}>
            {s.name}
          </a>
        ) : (
          <span className={c.name} title={s.name}>
            {s.name}
          </span>
        )}
        <span role={t ? "status" : undefined} title={playersTitle}>
          {status}
        </span>
      </span>
      {tall && who && !t ? (
        <span className={c.who} data-wrap={solo ? "" : undefined} title={playersTitle}>
          {who}
        </span>
      ) : null}
      {admin && (actions.length > 0 || (t && !t.watching) || t?.verdict.kind === "failed" || menu.length > 0) ? (
        <span className={c.controls}>
          {t && (t.verdict.kind === "failed" || !t.watching) ? (
            <Button size="sm" variant="ghost" aria-label={`Dismiss the message about ${s.name}`} onClick={() => onDismiss(s.id)}>
              Dismiss
            </Button>
          ) : null}
          {actions.length ? (
            <span className={c.inline}>
              {actions.map((a) => (
                <Button key={a.action} size="sm" variant={a.action === "kill" ? "danger" : "secondary"} aria-label={`${a.label} ${s.name}`} onClick={() => onCommand(s, a.action)}>
                  {a.label}
                </Button>
              ))}
            </span>
          ) : null}
          {/* Narrow widgets: Start stays a button (it's short and never needs asking); the rest fold into a menu. */}
          {actions.length === 1 && actions[0]!.action === "start" ? (
            <span className={c.compact}>
              <Button size="sm" aria-label={`Start ${s.name}`} onClick={() => onCommand(s, "start")}>
                Start
              </Button>
            </span>
          ) : menu.length && (actions.length || !href) ? (
            <span className={c.compact}>
              <Menu
                trigger={
                  <IconButton label={`Actions for ${s.name}`} size="sm">
                    <MoreHoriz />
                  </IconButton>
                }
                items={menu}
              />
            </span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

function confirmCopy(s: CraftyServer, action: CraftyAction) {
  const on = s.players?.online ?? 0;
  const who = s.players && on ? names(s.players, 4) : "";
  const kicked = on ? `${plural(on, "player")} will be disconnected${who ? `: ${who}` : ""}.` : null;
  switch (action) {
    case "kill":
      return {
        title: `Force-stop ${s.name}?`,
        description: "Crafty ends the server process straight away, like pulling the plug. Anything since the world last saved is lost.",
        consequences: kicked ? [kicked] : undefined,
        confirmLabel: "Force-stop",
        variant: "dangerSolid" as const,
      };
    case "restart":
      return { title: `Restart ${s.name}?`, description: `${kicked} They can join again once it's back up.`, confirmLabel: "Restart", variant: "primary" as const };
    default:
      return { title: `Stop ${s.name}?`, description: `${kicked} The world is saved first.`, confirmLabel: "Stop", variant: "primary" as const };
  }
}

/** "4 more servers, 2 running": what the rows that didn't fit are doing, so nothing running goes unseen. */
function moreLine(rest: CraftyServer[]): string {
  const up = rest.filter((s) => s.line !== "stopped").length;
  const head = `${rest.length} more ${rest.length === 1 ? "server" : "servers"}`;
  if (!up) return head;
  return up === rest.length ? `${head}, ${rest.length === 1 ? "running" : "all running"}` : `${head}, ${up} running`;
}

/**
 * The rows that fit, whole: a row that would be cut is hidden (useFit) and counted in a "more" line that opens
 * every server in a sheet, the way the uptime and needs-you widgets count what they couldn't show.
 */
function ServerList({ list, dense, tall, row }: { list: CraftyServer[]; dense: boolean; tall: boolean; row: (s: CraftyServer, o?: { hidden?: boolean; inSheet?: boolean }) => React.ReactNode }) {
  const [listRef, fit] = useFit<HTMLUListElement>(list.length);
  const [open, setOpen] = React.useState(false);
  const hidden = list.length - fit;
  const single = list.length === 1;
  return (
    <div className={c.wrap} data-dense={dense ? "" : undefined}>
      {tall && !single ? (
        <p className={c.summary} title={summary(list)}>
          {summary(list)}
        </p>
      ) : null}
      <ul ref={listRef} className={c.rows} role="list" data-single={single ? (tall ? "tall" : "") : undefined}>
        {list.map((s, i) => row(s, { hidden: i >= fit }))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className={c.more} onClick={() => setOpen(true)}>
          {moreLine(list.slice(fit))}
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen} title="Minecraft servers" description={summary(list)} size="wide">
        <ul className={`${c.rows} ${c.sheet}`} role="list">
          {list.map((s) => row(s, { inSheet: true }))}
        </ul>
      </Dialog>
    </div>
  );
}

export function CraftyServers({ item, size }: WidgetProps<IntegrationConfig>) {
  const q = useIntegrationWidget("crafty", "crafty.servers", item.config.integration, {});
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const url = useSmartUrl();
  const ref: IntegrationRef | null = q.source.state === "ok" ? q.source.ref : null;
  const { tracked, settled, run, dismiss } = useCommands(ref?.id ?? null);
  const busy = Object.values(tracked).some((t) => t.watching);
  const now = useTick(busy ? 1000 : 30_000);
  const [confirm, confirmNode] = useConfirm();
  const order = React.useRef<string[]>([]);
  const base = ref ? url(ref.links) : null;
  const hrefFor = (id: string) => {
    if (!base) return null;
    try {
      return new URL(`/panel/server_detail?id=${encodeURIComponent(id)}`, base).toString();
    } catch {
      return null;
    }
  };

  function command(s: CraftyServer, action: CraftyAction) {
    if (!run) return;
    const go = () => run(s, action);
    const failed = (e: unknown) =>
      toast.error(`Couldn't ${action === "kill" ? "force-stop" : action} ${s.name}`, { description: e instanceof ApiError ? e.message : "Gluon couldn't reach Crafty." });
    // Stop and Restart ask only when someone would be thrown off; force-stop always asks.
    if (action === "kill" || ((action === "stop" || action === "restart") && (s.players?.online ?? 0) > 0)) {
      confirm({ ...confirmCopy(s, action), onConfirm: go });
      return;
    }
    go().catch(failed);
  }

  const wide = size === "w" || size === "x" || size === "l";
  const tall = size === "t" || size === "l" || size === "x";
  // The short wide sizes put each server on one line, so three fit where two would.
  const dense = size === "m" || size === "w";
  const fetchedAt = q.response?.fetchedAt ?? 0;
  // Crafty itself is still coming up: nothing answers yet, but it will in a moment.
  if (!q.data && q.error && (q.error.code === "unreachable" || q.error.code === "timeout") && ref?.appLine === "starting") {
    return <WidgetState line="starting" title="Crafty is starting up">Your servers show here once it's ready.</WidgetState>;
  }
  return (
    <>
      <Gate kind="crafty" source={q.source} q={q} skeleton={<RowsSkeleton rows={size === "s" ? 2 : 3} />}>
        {(d: CraftyServersData) => {
          if (!d.servers.length) {
            return (
              <Quiet title="No servers in Crafty yet">
                {admin ? "Make one in Crafty and it shows up here. If Crafty already has some, give Gluon's Crafty user a role with those servers." : "When there's a server to play on, it shows up here."}
              </Quiet>
            );
          }
          const list = ordered(
            d.servers.map((s) => (tracked[s.id]?.watching ? tracked[s.id]!.server : null) ?? (settled[s.id] && settled[s.id]!.at > fetchedAt ? settled[s.id]!.server : s)),
            busy ? order.current : null,
          );
          order.current = list.map((s) => s.id);
          const row = (s: CraftyServer, o: { hidden?: boolean; inSheet?: boolean } = {}) => (
            <ServerRow
              key={s.id}
              s={s}
              t={tracked[s.id]}
              admin={admin}
              live={!q.error}
              wide={o.inSheet ? true : wide}
              tall={o.inSheet ? true : tall}
              solo={list.length === 1 && tall}
              hidden={o.hidden}
              now={now}
              href={hrefFor(s.id)}
              onCommand={command}
              onDismiss={dismiss ?? (() => {})}
            />
          );
          return <ServerList list={list} dense={dense} tall={tall} row={row} />;
        }}
      </Gate>
      {confirmNode}
    </>
  );
}
