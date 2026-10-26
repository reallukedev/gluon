"use client";
import * as React from "react";
import Link from "next/link";
import type { SWRResponse } from "swr";
import type { LiveLogins, LiveSession, SignInHistory, SignInSource, SshPosture } from "@/lib/system-types";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { SignInChart } from "./SignInChart";
import { KIND_HELP, KIND_ORDER, KIND_WORDS, methodWords, ZONE_WORDS } from "./loginWords";
import s from "./signins.module.css";

// ---------------------------------------------------------------- tab

export function SignInsTab({ live }: { live: SWRResponse<LiveLogins, ApiError> }) {
  const history = useApi<SignInHistory>("/api/system/logins/history", {
    refresh: 60_000,
  });
  const { data, error, mutate } = live;

  if (!data) {
    if (error) {
      return (
        <Notice tone="fault" title="Couldn't see who is signed in" action={<Button onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      );
    }
    return <SignInsSkeleton />;
  }

  return (
    <div className={s.stack}>
      <ConnectedNow data={data} onChanged={() => void mutate()} />
      <WeekPanel history={history} live={data} />
      <div className={s.grid}>
        <SourcesPanel history={history.data} loading={!history.data && !history.error} />
        <PosturePanel posture={data.posture} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- connected now

function ConnectedNow({ data, onChanged }: { data: LiveLogins; onChanged: () => void }) {
  const fmt = useFormat();
  const [confirm, confirmNode] = useConfirm();
  const [ending, setEnding] = React.useState<string | null>(null);

  const groups = React.useMemo(() => {
    const m = new Map<string, LiveSession[]>();
    for (const x of data.sessions) (m.get(x.user) ?? m.set(x.user, []).get(x.user)!).push(x);
    for (const list of m.values()) list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.startedAt - a.startedAt);
    return [...m.entries()].sort((a, b) => Number(b[1].some((x) => x.from.zone === "away")) - Number(a[1].some((x) => x.from.zone === "away")) || a[0].localeCompare(b[0]));
  }, [data.sessions]);

  function askEnd(x: LiveSession) {
    const where = x.kind === "console" ? "at the server's keyboard" : x.from.ip ? `from ${x.from.ip}` : "";
    const what = x.running && x.running.label !== "At the prompt" ? `${x.running.program} stops, and anything unsaved in it is lost.` : "Anything running in it stops, and unsaved work in it is lost.";
    confirm({
      title: `End ${x.user}'s session?`,
      description: `${KIND_WORDS[x.kind]} ${where}, started ${fmt.relative(x.startedAt)}.`,
      consequences: [
        x.kind === "console" ? "They're signed out on the server's screen straight away." : "Their connection drops straight away.",
        what,
        x.method === "key"
          ? "They can sign in again with the same key. To keep them out, remove the key from their authorized_keys."
          : "They can sign in again with the same password. To keep them out, change it first.",
      ],
      confirmLabel: "End session",
      variant: "dangerSolid",
      onConfirm: async () => {
        setEnding(x.id);
        try {
          const r = await api.del<{ message: string }>(`/api/system/logins/${encodeURIComponent(x.id)}`);
          toast.success(r.message);
          onChanged();
        } catch (e) {
          if (e instanceof ApiError && e.code === "reauth_cancelled") return;
          throw e;
        } finally {
          setEnding(null);
        }
      },
    });
  }

  const n = data.sessions.length;
  return (
    <Panel
      title="Connected now"
      meta={
        <span className="num">
          {n ? `${fmt.plural(n, "session")} · ` : ""}checked <Time ts={data.checkedAt} kind="time" seconds />
        </span>
      }
      flush
    >
      {n === 0 ? (
        <Empty title="Nobody is signed in to the machine">
          People who sign in over SSH, or at a keyboard plugged into the server, appear here while they're connected. Apps and shared folders aren't sign-ins, so they don't show up.
        </Empty>
      ) : (
        <div className={s.people}>
          {groups.map(([user, list]) => (
            <section key={user} className={s.person} aria-label={`${user}, ${fmt.plural(list.length, "session")}`}>
              <header className={s.personHead}>
                <span className={s.personName}>{user}</span>
                <span className={`${s.personMeta} num`}>{personSummary(list, fmt.plural)}</span>
              </header>
              <ul className={s.sessions}>
                {list.map((x) => (
                  <SessionRow key={x.id} x={x} ending={ending === x.id} onEnd={() => askEnd(x)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {confirmNode}
    </Panel>
  );
}

function personSummary(list: LiveSession[], plural: (n: number, one: string, many?: string) => string): string {
  const zones = [...new Set(list.map((x) => x.from.zone))];
  const where = zones.length === 1 ? (zones[0] === "home" ? "from home" : zones[0] === "away" ? "from outside" : "at the server") : "from several places";
  return `${plural(list.length, "session")} ${where}`;
}

function SessionRow({ x, ending, onEnd }: { x: LiveSession; ending: boolean; onEnd: () => void }) {
  const fmt = useFormat();
  const state: LineState = x.from.zone === "away" ? "attention" : "running";
  const running = x.running;
  const idle = x.idleSeconds !== null && x.idleSeconds >= 60 ? `idle ${fmt.duration(x.idleSeconds, 1)}` : x.idleSeconds !== null ? "active now" : null;
  const method = methodWords(x.method, x.keyLabel);
  return (
    <li className={s.session}>
      <span className={s.sessionMark}>
        <StateLine state={state} label={false} />
      </span>
      <span className={s.sessionWhat}>
        <span className={s.sessionKind} title={KIND_HELP[x.kind]}>
          {KIND_WORDS[x.kind]}
          {x.tty && <span className={`${s.dim} mono`}> {x.tty}</span>}
        </span>
        <span className={s.sessionRunning}>
          {running ? (
            <>
              {running.label && <span>{running.label}</span>}
              {running.label !== "At the prompt" && <span className={`${s.program} mono`}>{running.program}</span>}
            </>
          ) : (
            <span className={s.dim}>{x.kind === "tunnel" ? "Nothing running" : "None"}</span>
          )}
        </span>
      </span>
      <span className={s.sessionFrom}>
        {x.from.ip ? (
          <span className={`${s.ip} mono`} title={x.from.port ? `${x.from.ip}, port ${x.from.port}` : x.from.ip}>
            {x.from.ip}
          </span>
        ) : (
          <span>{x.kind === "console" ? "The server's own keyboard" : "Unknown"}</span>
        )}
        <span className={s.dim}>
          {x.from.zone === "away" ? <b className={s.away}>{ZONE_WORDS.away}</b> : ZONE_WORDS[x.from.zone]}
          {x.from.host ? (
            <span className={s.host} title={x.from.host}>
              {" "}
              · {x.from.host}
            </span>
          ) : null}
        </span>
      </span>
      <span className={s.sessionWhen}>
        <span className="num">
          Since <Time ts={x.startedAt} />
        </span>
        <span className={`${s.dim} num`}>{[idle, method].filter(Boolean).join(" · ")}</span>
      </span>
      <span className={s.sessionAction}>
        {x.canEnd ? (
          <Button size="sm" variant="ghost" loading={ending} onClick={onEnd} aria-label={`End ${x.user}'s ${KIND_WORDS[x.kind].toLowerCase()} session${x.from.ip ? ` from ${x.from.ip}` : ""}`}>
            End…
          </Button>
        ) : (
          <span className={s.dim} title={x.endBlocked ?? undefined}>
            Can't end
          </span>
        )}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- the week

function WeekPanel({ history, live }: { history: SWRResponse<SignInHistory, ApiError>; live: LiveLogins }) {
  const fmt = useFormat();
  const h = history.data;
  let meta: React.ReactNode = null;
  if (h) {
    const people = h.lanes.length;
    const sessions = h.lanes.reduce((a, l) => a + l.sessions, 0);
    meta = (
      <span className="num">
        Last 7 days: {fmt.plural(sessions, "sign-in")} by {fmt.plural(people, "person", "people")}
        {h.failures.total ? ` · ${fmt.plural(h.failures.total, "failed attempt")}` : ""}
      </span>
    );
  }
  return (
    <Panel title="Sign-in history" meta={meta} flush>
      {!h ? (
        history.error ? (
          <div className={s.pad}>
            <Notice tone="fault" title="Couldn't read the sign-in history" action={<Button onClick={() => void history.mutate()}>Try again</Button>}>
              {history.error.message}
            </Notice>
          </div>
        ) : (
          <div className={s.pad}>
            <Skeleton height={18} width="40%" />
            <div style={{ height: 12 }} />
            <Skeleton height={120} radius={8} />
          </div>
        )
      ) : (
        <>
          {!h.origin.journal && !h.origin.wtmp ? (
            <div className={s.pad}>
              <Notice tone="neutral" title="There's no sign-in history to show">
                The system journal and the login records (wtmp) are both empty or unreadable, so only live sessions appear above.
              </Notice>
            </div>
          ) : (
            <SignInChart history={h} live={live} />
          )}
          {h.failures.total > 0 && <FailureDetails h={h} />}
          {h.oldestRecord && h.oldestRecord > h.from + 6 * 3_600_000 && (
            <p className={s.foot}>
              Records start <Time ts={h.oldestRecord} kind="dateTime" />; the system keeps a limited amount of log history.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function FailureDetails({ h }: { h: SignInHistory }) {
  const fmt = useFormat();
  const f = h.failures;
  const unknownNames = f.names.filter((n) => !n.exists);
  return (
    <div className={s.failures}>
      <div className={s.failCol}>
        <h3 className={s.subhead}>Failed attempts this week came from</h3>
        <ul className={s.srcList}>
          {f.sources.slice(0, 5).map((x) => (
            <li key={x.ip}>
              <span className={s.srcMain}>
                <span className={`${s.ip} mono`} title={x.ip}>
                  {x.ip}
                </span>
                <span className={s.dim}>
                  {x.zone === "away" ? <b className={s.away}>{ZONE_WORDS.away}</b> : ZONE_WORDS[x.zone]}
                  {x.host ? <span className={s.host}> · {x.host}</span> : null}
                </span>
              </span>
              <span className={s.srcCount}>
                <span className="num">{fmt.plural(x.count, "attempt")}</span>
                <span className={`${s.dim} num`}>
                  as {x.users.join(", ")} · <Time ts={x.lastAt} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={s.failCol}>
        <h3 className={s.subhead}>Account names they tried</h3>
        <ul className={s.nameList}>
          {f.names.map((n) => (
            <li key={n.name}>
              <span className="mono">{n.name}</span>
              <span className={`${s.dim} num`}>
                {n.count}× {n.exists ? "" : "· no such account"}
              </span>
            </li>
          ))}
        </ul>
        <p className={s.note}>
          {unknownNames.length === f.names.length
            ? "None of these accounts exist here, so these attempts could never work."
            : "Attempts on real accounts are worth a look if you don't recognise the address."}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- where sign-ins come from

function SourcesPanel({ history, loading }: { history?: SignInHistory; loading: boolean }) {
  const fmt = useFormat();
  return (
    <Panel title="Where sign-ins come from" meta={history ? <span>Last 7 days</span> : undefined} flush>
      {loading ? (
        <div className={s.pad}>
          <Skeleton height={16} width="70%" />
          <div style={{ height: 10 }} />
          <Skeleton height={16} width="55%" />
        </div>
      ) : !history?.sources.length ? (
        <Empty title="No sign-ins this week">Each person and address that signs in appears here, with how they signed in.</Empty>
      ) : (
        <ul className={`${s.sources} appear`}>
          {history.sources.map((x) => (
            <SourceRow key={`${x.user}|${x.ip}|${x.method}|${x.keyLabel}`} x={x} plural={fmt.plural} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SourceRow({ x, plural }: { x: SignInSource; plural: (n: number, one: string, many?: string) => string }) {
  const method = methodWords(x.method, x.keyLabel);
  return (
    <li className={s.source}>
      <span className={s.sessionMark}>
        <StateLine state={x.zone === "away" ? "attention" : x.open ? "running" : "stopped"} label={false} />
      </span>
      <span className={s.srcMain}>
        <span className={s.srcTitle}>
          <b>{x.user}</b> {x.ip ? <span className={`${s.ip} mono`}>{x.ip}</span> : <span>at the server</span>}
        </span>
        <span className={s.dim}>
          {x.zone === "away" ? <b className={s.away}>{ZONE_WORDS.away}</b> : ZONE_WORDS[x.zone]}
          {x.host ? <span className={s.host}> · {x.host}</span> : null}
          {method ? ` · ${method}` : ""}
        </span>
      </span>
      <span className={s.srcCount}>
        <span className="num">{plural(x.count, "sign-in")}</span>
        <span className={`${s.dim} num`}>
          {x.open ? (
            `${x.open} connected now`
          ) : (
            <>
              last <Time ts={x.lastAt} />
            </>
          )}
        </span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- posture

interface Fact {
  key: string;
  state: LineState;
  title: string;
  meaning: string;
  change?: { setting: string; how: string };
}

function postureFacts(p: SshPosture): Fact[] {
  const out: Fact[] = [];
  const port = p.ports.length ? p.ports.join(", ") : "22";
  if (p.password === true)
    out.push({
      key: "pw",
      state: p.seenFromOutside ? "attention" : "running",
      title: "Passwords are accepted",
      meaning: p.seenFromOutside
        ? "SSH answers from the internet, so anyone who guesses or steals a password can get in. Signing in with keys only is much safer."
        : "Anyone who knows a password can sign in. Keys are safer, especially if SSH is ever opened to the internet.",
      change: {
        setting: "PasswordAuthentication no\nKbdInteractiveAuthentication no",
        how: "Make sure you can sign in with a key first, or you'll lock yourself out.",
      },
    });
  else if (p.password === false)
    out.push({
      key: "pw",
      state: "running",
      title: "Only keys are accepted",
      meaning: "Passwords don't work over SSH, so guessing them can't get anyone in.",
    });

  if (p.emptyPasswords)
    out.push({
      key: "empty",
      state: "unhealthy",
      title: "Accounts without a password can sign in",
      meaning: "Anyone could sign in to such an account with no password at all.",
      change: { setting: "PermitEmptyPasswords no", how: "" },
    });

  if (p.root === "yes")
    out.push({
      key: "root",
      state: p.password ? "attention" : "running",
      title: p.password ? "root can sign in with a password" : "root can sign in",
      meaning: "root can do anything on the machine. It's safer to sign in as yourself and use sudo.",
      change: { setting: "PermitRootLogin no", how: "" },
    });
  else if (p.root === "keys-only")
    out.push({
      key: "root",
      state: "running",
      title: "root can sign in, but only with a key",
      meaning: "Passwords never work for root. Only someone holding one of root's keys can sign in as root.",
      change: {
        setting: "PermitRootLogin no",
        how: "To stop root signing in at all.",
      },
    });
  else if (p.root === "commands-only")
    out.push({
      key: "root",
      state: "running",
      title: "root can only run set commands",
      meaning: "root can sign in with a key that's limited to a fixed command.",
    });
  else if (p.root === "no")
    out.push({
      key: "root",
      state: "running",
      title: "root can't sign in over SSH",
      meaning: "People sign in as themselves and use sudo for admin work.",
    });

  out.push({
    key: "port",
    state: "running",
    title: `SSH listens on port ${port}`,
    meaning: p.seenFromOutside
      ? "Addresses outside your home reached it this week, so it's open to the internet (your router forwards it, or the server has a public address)."
      : "Nothing from outside your home reached it this week. If it isn't forwarded on your router, only your home network can use it.",
  });

  if (p.blocker)
    out.push({
      key: "block",
      state: p.blocker.running ? "running" : "attention",
      title: p.blocker.running ? `${p.blocker.name} blocks repeat offenders` : `${p.blocker.name} is installed but not running`,
      meaning: p.blocker.running ? "Addresses that keep failing to sign in get blocked for a while." : "Repeated failed sign-ins aren't being blocked.",
    });
  else
    out.push({
      key: "block",
      state: p.seenFromOutside && p.password ? "attention" : "running",
      title: "Nothing blocks repeated failures",
      meaning: p.seenFromOutside
        ? "An address can keep guessing for as long as it likes. fail2ban blocks addresses that keep failing."
        : "Fine while SSH only answers at home. fail2ban can block addresses that keep failing.",
    });
  return out;
}

function PosturePanel({ posture }: { posture: SshPosture }) {
  if (!posture.installed) {
    return (
      <Panel title="How SSH is set up">
        <Empty title="SSH isn't installed">Nobody can sign in to this machine from another computer. Gluon doesn't need SSH.</Empty>
      </Panel>
    );
  }
  const facts = postureFacts(posture);
  const serviceHref = `/system?tab=services&unit=${encodeURIComponent(posture.unit ?? "ssh.service")}`;
  return (
    <Panel title="How SSH is set up" meta={posture.running === false ? <StateLine state="stopped" label="Not running" /> : posture.running ? <span>Remote login is on</span> : undefined} flush>
      {posture.error ? (
        <div className={s.pad}>
          <Notice tone="neutral" title="Gluon couldn't read the SSH settings">
            <span className="mono">sshd -T</span> didn't answer. The rest of this page still works.
          </Notice>
        </div>
      ) : (
        <ul className={s.facts}>
          {facts.map((f) => (
            <li key={f.key} className={s.fact}>
              <span className={s.sessionMark}>
                <StateLine state={f.state} label={false} />
              </span>
              <span className={s.factText}>
                <span className={s.factTitle}>{f.title}</span>
                <span className={s.dim}>{f.meaning}</span>
              </span>
              {f.change && (
                <Popover
                  side="left"
                  align="start"
                  title="Where to change it"
                  trigger={
                    <Button size="sm" variant="ghost">
                      How to change
                    </Button>
                  }
                >
                  <span className={s.howTo}>
                    <span>
                      Over SSH, set this in <code>/etc/ssh/sshd_config</code> (or a file in <code>/etc/ssh/sshd_config.d/</code>, which wins):
                    </span>
                    <pre className={s.code}>{f.change.setting}</pre>
                    <span>
                      Then restart <Link href={serviceHref}>Remote login (SSH)</Link> in Services. People already signed in stay connected.
                    </span>
                    {f.change.how && <span className={s.dim}>{f.change.how}</span>}
                  </span>
                </Popover>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className={s.foot}>Gluon only reads these settings; it never changes how SSH is set up.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- skeleton

function SignInsSkeleton() {
  return (
    <div className={s.stack} aria-busy>
      <Panel title="Connected now">
        <div className={s.skelRows}>
          {[70, 55, 62].map((w, i) => (
            <Skeleton key={i} height={18} width={`${w}%`} />
          ))}
        </div>
      </Panel>
      <Panel title="Sign-in history">
        <Skeleton height={140} radius={8} />
      </Panel>
    </div>
  );
}
