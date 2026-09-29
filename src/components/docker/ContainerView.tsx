"use client";
import * as React from "react";
import Link from "next/link";
import { Journal, Play } from "iconoir-react";
import { useApi, streamPost, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Disclosure } from "@/components/ui/Disclosure";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { Time } from "@/components/ui/Time";
import type { ContainerInspect, ExecEvent } from "@/lib/docker-types";
import { LoadError, appHref, appWords, firstError, type InitialError } from "./shared";
import s from "./docker.module.css";

const EXIT: Record<number, string> = {
  0: "exited normally",
  1: "exited with an error",
  126: "couldn't run its program",
  127: "couldn't find its program",
  137: "was killed (out of memory, or force-stopped)",
  139: "crashed (segmentation fault)",
  143: "was asked to stop",
};

function stateWords(c: ContainerInspect): React.ReactNode {
  if (c.state === "running")
    return c.startedAt ? (
      <>
        Running since <Time ts={c.startedAt} kind="dateTime" />
        {c.health ? `, ${c.health}` : ""}
      </>
    ) : (
      "Running"
    );
  if (c.state === "exited" || c.state === "dead")
    return (
      <>
        Stopped{c.finishedAt ? <> <Time ts={c.finishedAt} /></> : null}
        {c.exitCode !== null ? `: ${EXIT[c.exitCode] ?? `exit code ${c.exitCode}`}` : ""}
      </>
    );
  if (c.state === "created") return "Created, never started";
  if (c.state === "restarting") return "Restarting over and over";
  if (c.state === "paused") return "Paused";
  return c.state;
}

export function ContainerView({ id, initial, initialError }: { id: string; initial: ContainerInspect | null; initialError: InitialError }) {
  const { data: c, error: liveError, mutate, isValidating } = useApi<ContainerInspect>(`/api/docker/containers/${encodeURIComponent(id)}`, { refresh: 15_000, fallbackData: initial ?? undefined });
  const error = liveError ?? firstError(c, initialError);
  const back = c?.app ? { href: appHref(c.app), label: c.app.name } : { href: "/apps", label: "Apps" };

  if (!c) {
    return (
      <Page>
        <PageHeader back={back} title={id} summary={error ? undefined : "Asking Docker…"} />
        {error ? (
          error instanceof ApiError && error.status === 404 ? (
            <Empty title="That container is gone">It was removed or recreated (an update gives containers a new ID). Find it again from its app in Apps.</Empty>
          ) : (
            <LoadError error={error} what="the container" onRetry={() => void mutate()} retrying={isValidating} />
          )
        ) : (
          <div className={s.grid2}>
            <Skeleton height={320} radius={12} />
            <Skeleton height={320} radius={12} />
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        back={back}
        title={<span className={s.ctrTitle}><span>{c.name}</span></span>}
        summary={
          <span className={s.ctrSummary}>
            <span className={s.useLine}>
              <StateLine state={c.line} />
              <span>{stateWords(c)}</span>
            </span>
            {c.app && (
              <span>
                Part of <Link href={appHref(c.app)}>{appWords(c.app)}</Link>
              </span>
            )}
            {c.self && <span>This is Gluon.</span>}
          </span>
        }
        actions={
          c.app ? (
            <LinkButton href={`${appHref(c.app)}?tab=logs&container=${encodeURIComponent(c.name)}`} icon={<Journal />}>
              Logs
            </LinkButton>
          ) : undefined
        }
      />
      {error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={error} what="the container" onRetry={() => void mutate()} retrying={isValidating} />
        </div>
      )}
      <div className={s.grid2}>
        <Details c={c} />
        <div style={{ display: "grid", gap: 20 }}>
          <Storage c={c} />
          <Networks c={c} />
        </div>
        <div className={s.span2}>
          <RunCommand c={c} />
        </div>
        <div className={s.span2}>
          <Inspect c={c} />
        </div>
      </div>
    </Page>
  );
}

function Details({ c }: { c: ContainerInspect }) {
  return (
    <Panel title="Details">
      <dl className={s.kv} style={{ marginTop: 0 }}>
        <dt>Image</dt>
        <dd>
          <Link href={`/apps/images?q=${encodeURIComponent(c.image.ref.split("@")[0]!)}`} className={s.monoWrap}>
            {c.image.ref}
          </Link>
        </dd>
        <dt>ID</dt>
        <dd>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="mono">{c.id.slice(0, 12)}</span>
            <CopyButton value={c.id} label="Copy container ID" />
          </span>
        </dd>
        <dt>Created</dt>
        <dd>
          <Time ts={c.created} kind="dateTime" />
        </dd>
        <dt>Restarts</dt>
        <dd>
          <span className="num">{c.restartCount}</span> so far · restart policy <span className="mono">{c.restartPolicy}</span>
        </dd>
        {c.entrypoint && (
          <>
            <dt>Entrypoint</dt>
            <dd className={s.monoWrap}>{c.entrypoint}</dd>
          </>
        )}
        {c.command && (
          <>
            <dt>Command</dt>
            <dd className={s.monoWrap}>{c.command}</dd>
          </>
        )}
        {c.workingDir && (
          <>
            <dt>Working folder</dt>
            <dd className={s.monoWrap}>{c.workingDir}</dd>
          </>
        )}
        <dt>Runs as</dt>
        <dd>{c.user ? <span className="mono">{c.user}</span> : "The image's default user (often root)"}</dd>
        <dt>Ports</dt>
        <dd>
          {c.ports.length ? (
            <ul className={s.plain}>
              {c.ports.map((p) => (
                <li key={`${p.host}/${p.proto}/${p.ip}`} className="mono">
                  {p.ip && p.ip !== "0.0.0.0" && p.ip !== "::" ? `${p.ip}:` : ""}
                  {p.host} → {p.container}/{p.proto}
                </li>
              ))}
            </ul>
          ) : c.networkMode === "host" ? (
            "Uses the server's own network, so its ports are the server's"
          ) : (
            <span className={s.faint}>None published</span>
          )}
        </dd>
      </dl>
    </Panel>
  );
}

function Storage({ c }: { c: ContainerInspect }) {
  return (
    <Panel title="Storage" meta={c.mounts.length ? `${c.mounts.length}` : undefined}>
      {c.mounts.length === 0 ? (
        <p className={s.faint} style={{ margin: 0 }}>
          Nothing mounted. Whatever it writes lives in the container and goes when it&apos;s recreated.
        </p>
      ) : (
        <ul className={s.plain}>
          {c.mounts.map((m) => (
            <li key={`${m.destination}`}>
              <span className="mono">{m.destination}</span>
              <span className={s.faint}> from </span>
              {m.type === "volume" && m.volume ? (
                <Link href={`/apps/volumes?q=${encodeURIComponent(m.volume)}`} className="mono">
                  {/^[0-9a-f]{64}$/.test(m.volume) ? `volume ${m.volume.slice(0, 12)}` : `volume ${m.volume}`}
                </Link>
              ) : m.type === "bind" ? (
                <Link href={`/files?path=${encodeURIComponent(m.source)}`} className="mono">
                  {m.source}
                </Link>
              ) : (
                <span className="mono">{m.type}</span>
              )}
              {!m.rw && <span className={s.faint}>, read-only</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Networks({ c }: { c: ContainerInspect }) {
  return (
    <Panel title="Networks">
      {c.networkMode === "host" ? (
        <p style={{ margin: 0 }}>Uses the server&apos;s own network directly (host mode).</p>
      ) : c.networks.length === 0 ? (
        <p className={s.faint} style={{ margin: 0 }}>
          On no network: it can&apos;t reach anything and nothing can reach it.
        </p>
      ) : (
        <ul className={s.plain}>
          {c.networks.map((n) => (
            <li key={n.name}>
              <Link href={`/apps/networks?q=${encodeURIComponent(n.name)}`} className="mono">
                {n.name}
              </Link>
              {(n.ipv4 || n.ipv6) && <span className={`${s.faint} mono`}> · {[n.ipv4, n.ipv6].filter(Boolean).join(" · ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- run a command

type Out = { text: string; err: boolean };

function RunCommand({ c }: { c: ContainerInspect }) {
  const fmt = useFormat();
  const [command, setCommand] = React.useState("");
  const [user, setUser] = React.useState("");
  const [workdir, setWorkdir] = React.useState("");
  const [limit, setLimit] = React.useState<"30" | "60" | "300" | "600">("60");
  const [running, setRunning] = React.useState(false);
  const [out, setOut] = React.useState<Out[]>([]);
  const [done, setDone] = React.useState<Extract<ExecEvent, { type: "done" }> | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [fieldErr, setFieldErr] = React.useState<{ field?: string; message: string } | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const pre = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out.length]);

  const blocked = c.self ? "Gluon doesn't run commands inside its own container. Use the server's terminal for that." : c.state !== "running" ? `${c.name} isn't running. Start it (from its app) to run a command in it.` : null;

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!command.trim()) {
      setFieldErr({ field: "command", message: "Type a command to run." });
      return;
    }
    setRunning(true);
    setOut([]);
    setDone(null);
    setFailure(null);
    setFieldErr(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      await streamPost<ExecEvent>(
        `/api/docker/containers/${encodeURIComponent(c.id)}/exec`,
        { command, user: user || null, workdir: workdir || null, timeoutSec: Number(limit) },
        (ev) => {
          if (ev.type === "out" || ev.type === "err") setOut((cur) => [...cur.slice(-3000), { text: ev.text, err: ev.type === "err" }]);
          else if (ev.type === "done") setDone(ev);
          else if (ev.type === "error") setFailure(ev.message);
        },
        ac.signal,
      );
    } catch (x) {
      if (x instanceof ApiError && x.code === "reauth_cancelled") return;
      if (x instanceof ApiError && x.field) setFieldErr({ field: x.field, message: x.message });
      else if (!ac.signal.aborted) setFailure(x instanceof Error ? x.message : "The command didn't run.");
    } finally {
      setRunning(false);
      abort.current = null;
    }
  }

  return (
    <Panel title="Run a command" meta="One command, no terminal: pipes and variables need sh -c '…'">
      {blocked ? (
        <p className={s.faint} style={{ margin: 0 }}>
          {blocked}
        </p>
      ) : (
        <form className={s.execForm} onSubmit={run}>
          {c.platform === "umbrel" && (
            <Notice tone="attention" title="This is part of Umbrel">
              Commands here can change how Umbrel works. Stick to reading things unless you know what the change does.
            </Notice>
          )}
          <Field label="Command" error={fieldErr?.field === "command" || (fieldErr && !fieldErr.field) ? fieldErr.message : null} description="Runs inside the container with its own programs, like ls -la /config or cat /etc/os-release.">
            <div className={s.execLine}>
              <Input mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="ls -la /config" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={2000} disabled={running} />
              {running ? (
                <Button onClick={() => abort.current?.abort()}>Stop</Button>
              ) : (
                <Button type="submit" variant="primary" icon={<Play />}>
                  Run
                </Button>
              )}
            </div>
          </Field>
          <Disclosure summary="Options" meta={user || workdir || limit !== "60" ? "changed" : undefined}>
            <div className={s.formRow} style={{ paddingTop: 8 }}>
              <Field label="As user" optional error={fieldErr?.field === "user" ? fieldErr.message : null}>
                <Input mono value={user} onChange={(e) => setUser(e.target.value)} placeholder={c.user ?? "default"} autoComplete="off" spellCheck={false} maxLength={65} />
              </Field>
              <Field label="In folder" optional error={fieldErr?.field === "workdir" ? fieldErr.message : null}>
                <Input mono value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder={c.workingDir ?? "/"} autoComplete="off" spellCheck={false} maxLength={400} />
              </Field>
              <Field label="Stop it after">
                <Select
                  aria-label="Time limit"
                  value={limit}
                  onChange={setLimit}
                  options={[
                    { value: "30", label: "30 seconds" },
                    { value: "60", label: "1 minute" },
                    { value: "300", label: "5 minutes" },
                    { value: "600", label: "10 minutes" },
                  ]}
                />
              </Field>
            </div>
          </Disclosure>
          {(out.length > 0 || running || done) && (
            <pre ref={pre} className={s.execOut} aria-live="polite" aria-label="Output">
              {out.length === 0 ? <span className={s.faint}>{running ? "Running…" : "It printed nothing."}</span> : out.map((o, i) => (o.err ? <span key={i} data-err="">{o.text}</span> : <React.Fragment key={i}>{o.text}</React.Fragment>))}
            </pre>
          )}
          {done && (
            <p className={s.execMeta} role="status">
              <span className={done.exitCode ? s.execBad : undefined}>
                {done.timedOut ? (
                  <b>Stopped at the time limit</b>
                ) : done.exitCode === null ? (
                  "Finished"
                ) : done.exitCode === 0 ? (
                  <>
                    Finished, exit code <b className="num">0</b>
                  </>
                ) : (
                  <>
                    Failed, exit code <b className="num">{done.exitCode}</b>
                    {EXIT[done.exitCode] ? ` (${EXIT[done.exitCode]})` : ""}
                  </>
                )}
              </span>
              <span className="num">{fmt.duration(Math.max(1, Math.round(done.ms / 1000)))}</span>
              {done.truncated && <span>Output past 1 MB was left out</span>}
            </p>
          )}
          {failure && (
            <Notice tone="fault" title="The command didn't run">
              {failure}
            </Notice>
          )}
        </form>
      )}
    </Panel>
  );
}

function Inspect({ c }: { c: ContainerInspect }) {
  const text = React.useMemo(() => JSON.stringify(c.raw, null, 2), [c.raw]);
  const fmt = useFormat();
  return (
    <Panel>
      <Disclosure summary="Docker's full description (inspect)" meta={`${fmt.bytes(text.length)} of JSON`}>
        <div className={s.jsonBar}>
          <span>Secret-looking settings are hidden. Everything else is as Docker reports it.</span>
          <CopyButton value={text} size="sm">
            Copy JSON
          </CopyButton>
        </div>
        <pre className={s.json} tabIndex={0} aria-label="Inspect output">
          {text}
        </pre>
      </Disclosure>
    </Panel>
  );
}
