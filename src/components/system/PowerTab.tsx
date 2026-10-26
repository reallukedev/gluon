"use client";
import * as React from "react";
import { SystemRestart, SystemShut, Clock } from "iconoir-react";
import type { PowerImpact, PowerStatus, TimeStatus } from "@/lib/system-types";
import { api, useApi, ApiError } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { Panel, Notice, Skeleton } from "@/components/ui/Surface";
import Link from "next/link";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { StateLine } from "@/components/ui/StateLine";
import s from "./system.module.css";
import pw from "./power.module.css";

type Action = "restart" | "shutdown";

export function PowerTab({ initial }: { initial?: PowerStatus }) {
  const { viewer } = usePrefs();
  const fmt = useFormat();
  const { data, error, mutate } = useApi<PowerStatus>("/api/system/power", {
    refresh: 15_000,
    fallbackData: initial,
  });
  const time = useApi<TimeStatus & { timezones: string[] }>("/api/system/time", { revalidateOnFocus: false });
  const [confirm, confirmNode] = useConfirm();
  const [going, setGoing] = React.useState<Action | null>(null);
  const [at, setAt] = React.useState("03:30");
  const [scheduling, setScheduling] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);

  if (going) return <Waiting action={going} />;

  if (!data) {
    if (error) {
      return (
        <Notice tone="fault" title="Couldn't read the power status" action={<Button onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      );
    }
    return (
      <div className={s.grid} aria-busy>
        <Panel title="Restart or shut down">
          <div className={s.skelRows}>
            <Skeleton height={18} width="60%" />
            <Skeleton height={18} width="70%" />
          </div>
        </Panel>
      </div>
    );
  }

  const tz = time.data?.timezone;
  const blocked = data.updateRunning;

  function now(action: Action) {
    const away = viewer.zone === "away";
    const impact = data!.impact;
    const back = impact?.apps.filter((a) => a.comesBack === "yes") ?? [];
    const off = impact?.apps.filter((a) => a.comesBack !== "yes") ?? [];
    const people = impact?.sessions ?? [];
    const extra: string[] = [];
    if (action === "restart" && impact) {
      if (off.length)
        extra.push(
          `${off
            .map((a) => a.name)
            .slice(0, 3)
            .join(
              ", ",
            )}${off.length > 3 ? ` and ${off.length - 3} more` : ""} won't start again on ${off.length === 1 ? "its" : "their"} own. Start ${off.length === 1 ? "it" : "them"} from Apps afterwards.`,
        );
    }
    if (people.length)
      extra.push(`${people.map((p) => `${p.user}'s ${fmt.plural(p.count, "SSH session")}`).join(" and ")} ${people.reduce((a, p) => a + p.count, 0) === 1 ? "is" : "are"} disconnected.`);
    confirm({
      title: action === "restart" ? "Restart the server now?" : "Shut the server down?",
      consequences:
        action === "restart"
          ? [
              "Everyone's apps and shared folders go offline for about 2 minutes. Anyone watching, listening or copying files is interrupted.",
              back.length ? `${fmt.plural(back.length, "app")} start${back.length === 1 ? "s" : ""} again on ${back.length === 1 ? "its" : "their"} own.` : "Apps start again on their own.",
              ...extra,
              "This page waits and reloads when the server is back.",
            ]
          : [
              "Every app and shared folder goes offline until the server is turned back on.",
              ...extra,
              "Someone has to press the power button on the server to turn it back on. Gluon can't do that remotely.",
              ...(away ? ["You're not at home right now, so you can't turn it back on yourself."] : []),
            ],
      confirmLabel: action === "restart" ? "Restart" : "Shut down",
      variant: action === "restart" ? "primary" : "dangerSolid",
      holdMs: 1500,
      onConfirm: async () => {
        await api.post("/api/system/power", { action, when: "now" });
        setGoing(action);
      },
    });
  }

  function schedule() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      toast.error("Choose a time like 03:30");
      return;
    }
    confirm({
      title: `Restart the server at ${at}?`,
      consequences: [
        `At ${at}${tz ? ` (${tz.replace(/_/g, " ")} time)` : " server time"}, within the next 24 hours, everyone's apps go offline for about 2 minutes.`,
        "You can cancel it here until then.",
      ],
      confirmLabel: "Schedule restart",
      variant: "primary",
      onConfirm: async () => {
        setScheduling(true);
        try {
          await api.post("/api/system/power", { action: "restart", when: at });
          toast.success(`Restart scheduled for ${at}`);
          void mutate();
        } finally {
          setScheduling(false);
        }
      },
    });
  }

  async function cancel() {
    setCancelling(true);
    try {
      const r = await api.del<{ cancelled: boolean }>("/api/system/power");
      toast.success(r.cancelled ? "Scheduled restart cancelled" : "Nothing was scheduled");
      void mutate();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled"))
        toast.error("Couldn't cancel it", {
          description: e instanceof Error ? e.message : undefined,
        });
    } finally {
      setCancelling(false);
    }
  }

  const sched = data.scheduled;
  const schedLabel = sched?.mode === "poweroff" ? "shut down" : "restart";

  return (
    <div className={s.stack}>
      {blocked && (
        <Notice tone="attention" title="Updates are being installed" action={<LinkButton href="/system?tab=updates">See progress</LinkButton>}>
          Restarting now could leave packages half-installed. Wait for the install to finish.
        </Notice>
      )}
      {!blocked && data.reboot.required && (
        <Notice tone="attention" title="A restart is needed to finish updating">
          {data.reboot.reasons.join(" ")}
        </Notice>
      )}
      <div className={pw.actions}>
        <section className={pw.action} aria-labelledby="pw-restart">
          <SystemRestart className={pw.actionIcon} aria-hidden />
          <div className={pw.actionText}>
            <h3 id="pw-restart" className={pw.actionTitle}>
              Restart
            </h3>
            <p className={pw.actionDesc}>Everything goes offline for about 2 minutes, then starts again on its own. Needed after some updates.</p>
          </div>
          <Button icon={<SystemRestart />} variant={data.reboot.required && !blocked ? "attention" : "secondary"} disabled={blocked} onClick={() => now("restart")}>
            Restart…
          </Button>
        </section>
        <section className={pw.action} aria-labelledby="pw-shut">
          <SystemShut className={pw.actionIcon} aria-hidden />
          <div className={pw.actionText}>
            <h3 id="pw-shut" className={pw.actionTitle}>
              Shut down
            </h3>
            <p className={pw.actionDesc}>The server turns off and stays off. Someone has to press its power button to turn it back on.</p>
          </div>
          <Button icon={<SystemShut />} variant="danger" disabled={blocked} onClick={() => now("shutdown")}>
            Shut down…
          </Button>
        </section>
      </div>

      <div className={s.grid}>
        <ImpactPanel impact={data.impact} />

        <Panel title="Scheduled restart">
          {sched ? (
            <div className={s.schedule}>
              <StateLine state="starting" label={`A ${schedLabel} is scheduled`} />
              <p className={s.scheduleWhen}>
                <Time ts={sched.at} kind="dateTime" />{" "}
                <span className={s.sub}>
                  (<Time ts={sched.at} />)
                </span>
              </p>
              <DayRuler at={sched.at} tz={tz} />
              <Button loading={cancelling} onClick={() => void cancel()}>
                Cancel the {schedLabel}
              </Button>
            </div>
          ) : (
            <form
              className={s.scheduleForm}
              onSubmit={(e) => {
                e.preventDefault();
                schedule();
              }}
            >
              <Field label="Restart at" description={`Server time${tz ? `, ${tz.replace(/_/g, " ")}` : ""}. The next time the clock shows this, within 24 hours. A quiet hour is best.`}>
                <Input type="time" value={at} onChange={(e) => setAt(e.target.value)} className={s.timeInput} required />
              </Field>
              <DayRuler hhmm={at} tz={tz} />
              <div>
                <Button type="submit" icon={<Clock />} loading={scheduling} disabled={blocked}>
                  Schedule restart
                </Button>
              </div>
            </form>
          )}
        </Panel>
      </div>
      {confirmNode}
    </div>
  );
}

// ---------------------------------------------------------------- what happens to apps

function ImpactPanel({ impact }: { impact: PowerImpact | null }) {
  const fmt = useFormat();
  if (!impact) {
    return (
      <Panel title="What happens to your apps">
        <p className={pw.note}>Gluon couldn't check the apps right now. Apps set to restart on their own come back after a restart.</p>
      </Panel>
    );
  }
  const back = impact.apps.filter((a) => a.comesBack === "yes");
  const off = impact.apps.filter((a) => a.comesBack !== "yes");
  return (
    <Panel title="What happens to your apps" meta={<span className="num">{fmt.plural(impact.apps.length, "app")} running</span>} flush>
      <p className={pw.lead}>
        {impact.apps.length === 0 ? (
          "No apps are running, so a restart only interrupts shared folders and anyone signed in."
        ) : off.length === 0 ? (
          <>
            After a restart, <b>every app</b> starts again on its own.
          </>
        ) : (
          <>
            After a restart, <b>{fmt.plural(back.length, "app")}</b> {back.length === 1 ? "starts" : "start"} again on {back.length === 1 ? "its" : "their"} own, but{" "}
            <b>{fmt.plural(off.length, "app")}</b> {off.length === 1 ? "stays" : "stay"} off until someone starts {off.length === 1 ? "it" : "them"} from Apps.
          </>
        )}
      </p>
      <ul className={pw.apps}>
        {[...off, ...back].map((a) => (
          <li key={a.id} className={pw.app}>
            <AppIcon src={a.icon} name={a.name} size={22} />
            <span className={pw.appName} title={a.name}>
              {a.name}
            </span>
            {a.comesBack === "yes" ? (
              <StateLine state="running" label={a.startedBy === "umbrel" ? "Comes back with Umbrel" : "Comes back"} />
            ) : (
              <span className={pw.off} title={a.staysOff.length ? `Stays off: ${a.staysOff.join(", ")}` : undefined}>
                <StateLine state="stopped" label={a.comesBack === "partly" ? `Partly: ${a.staysOff.slice(0, 2).join(", ")} stay${a.staysOff.length === 1 ? "s" : ""} off` : "Stays off"} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {impact.sessions.length > 0 && (
        <p className={pw.foot}>
          {impact.sessions.map((p) => `${p.user}'s ${fmt.plural(p.count, "SSH session")}`).join(" and ")} would be disconnected. <Link href="/system?tab=sign-ins">See who's connected</Link>
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- the next 24 hours

/** Minutes past midnight in `tz` for `ts`. */
function minutesIn(ts: number, tz: string | null | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: tz ?? undefined,
  }).formatToParts(ts);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
}

/** A ruler of the next 24 hours from now, with the restart marked on it. */
const noopSubscribe = () => () => {};

function DayRuler(props: { hhmm?: string; at?: number; tz: string | null | undefined }) {
  // "Now" differs between the server render and the browser; draw it once the browser owns the page.
  const mounted = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  return mounted ? <DayRulerLive {...props} /> : <div className={pw.rulerPlaceholder} aria-hidden />;
}

function DayRulerLive({ hhmm, at, tz }: { hhmm?: string; at?: number; tz: string | null | undefined }) {
  const fmt = useFormat();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  let mins: number | null = null;
  if (at) mins = Math.max(0, Math.round((at - now) / 60_000));
  else if (hhmm && /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) {
    const [h, m] = hhmm.split(":").map(Number);
    const target = h! * 60 + m!;
    const cur = minutesIn(now, tz);
    mins = (target - cur + 1440) % 1440 || 1440;
  }
  if (mins === null) return null;
  const nowMin = minutesIn(now, tz);
  // Hour ticks: label the midnight and midday that fall inside the window.
  const ticks = Array.from({ length: 25 }, (_, i) => i);
  const offsetToMidnight = (1440 - nowMin) % 1440;
  return (
    <div className={pw.ruler} aria-label={`In ${fmt.duration(mins * 60, 2)}`}>
      <div className={pw.rulerTrack} aria-hidden>
        {ticks.map((i) => (
          <i key={i} className={pw.rulerTick} style={{ left: `${(i / 24) * 100}%` }} />
        ))}
        <span className={pw.rulerMark} style={{ left: `${(offsetToMidnight / 1440) * 100}%` }} />
        <span className={pw.rulerSpan} style={{ transform: `scaleX(${mins / 1440})` }} />
        <span className={pw.rulerAt} style={{ left: `${(mins / 1440) * 100}%` }} />
      </div>
      <div className={`${pw.rulerLabels} num`} aria-hidden>
        <span>now</span>
        <span>+24 h</span>
      </div>
      <p className={pw.rulerText}>
        Restarts in <b className="num">{fmt.duration(mins * 60, 2)}</b>
        {offsetToMidnight > 0 && offsetToMidnight < mins ? ", after midnight" : ""}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- waiting for the server

type Phase = "stopping" | "down" | "back" | "slow";

/** After "restart now": watch Gluon go away and come back, then reload. */
function Waiting({ action }: { action: Action }) {
  const [phase, setPhase] = React.useState<Phase>("stopping");
  const [elapsed, setElapsed] = React.useState(0);
  const started = React.useRef(Date.now());
  const sawDown = React.useRef(false);

  React.useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stop) return;
      let ok = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch("/api/me", {
          cache: "no-store",
          credentials: "same-origin",
          signal: ctrl.signal,
        });
        clearTimeout(t);
        ok = r.ok || r.status === 401;
      } catch {
        ok = false;
      }
      const secs = (Date.now() - started.current) / 1000;
      if (!ok) {
        sawDown.current = true;
        setPhase(secs > 600 ? "slow" : "down");
      } else if (sawDown.current) {
        setPhase("back");
        setTimeout(() => window.location.reload(), 1200);
        return;
      } else if (secs > 120) {
        // Never went down: the restart didn't happen.
        setPhase("slow");
      }
      timer = setTimeout(poll, action === "shutdown" && sawDown.current ? 10_000 : 3000);
    };
    timer = setTimeout(poll, 2500);
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [action]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const text =
    phase === "back"
      ? "The server is back. Reloading…"
      : action === "shutdown"
        ? phase === "stopping"
          ? "Shutting down…"
          : "The server is off. Someone has to press its power button to turn it back on. This page reloads when it's back."
        : phase === "stopping"
          ? "Restarting. Apps are stopping…"
          : phase === "down"
            ? "The server is starting up again. This usually takes one to three minutes."
            : sawDown.current
              ? "This is taking longer than usual. If it doesn't come back, check the screen attached to the server."
              : "The server hasn't gone down. The restart may not have started; try again from Power.";

  return (
    <Panel title={action === "restart" ? "Restarting the server" : "Shutting down the server"}>
      <div className={s.waiting} role="status" aria-live="polite">
        <StateLine state={phase === "back" ? "running" : phase === "slow" ? "attention" : action === "shutdown" && phase === "down" ? "stopped" : "starting"} size={22} />
        <div>
          <p className={s.waitingText}>{text}</p>
          <p className={`${s.sub} num`}>
            {mins > 0 ? `${mins} min ` : ""}
            {secs} s
          </p>
        </div>
        {phase === "slow" && <Button onClick={() => window.location.reload()}>Reload now</Button>}
      </div>
    </Panel>
  );
}
