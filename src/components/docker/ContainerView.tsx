"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Journal, Play } from "iconoir-react";
import { useApi, ApiError } from "@/lib/client/api";
import { requestAutorun, terminalHref } from "@/lib/terminal/palette";
import { containerTarget } from "@/lib/terminal/types";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Disclosure } from "@/components/ui/Disclosure";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { Time } from "@/components/ui/Time";
import type { ContainerInspect } from "@/lib/docker-types";
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

/** A way into the Terminal for this container: type a command here and it runs there, or open a shell. */
function RunCommand({ c }: { c: ContainerInspect }) {
  const router = useRouter();
  const [command, setCommand] = React.useState("");
  const target = containerTarget(c.name);
  const blocked = c.self ? "Gluon doesn't run commands inside its own container. For the server itself, use the Terminal on this server." : c.state !== "running" ? `${c.name} isn't running. Start it (from its app) to run a command in it.` : null;

  function run(e: React.FormEvent) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd) return router.push(terminalHref(target));
    requestAutorun(target, cmd);
    router.push(terminalHref(target, cmd));
  }

  return (
    <Panel title="Run a command" meta={c.self ? <Link href={terminalHref("host")}>Terminal on this server</Link> : blocked ? undefined : <Link href={terminalHref(target, undefined, "terminal")}>Open a shell</Link>}>
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
          <Field label="Command" description="Opens the Terminal and runs it there, in this container's shell, where pipes, cd and Tab completion work.">
            <div className={s.execLine}>
              <Input mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="ls -la /config" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={2000} enterKeyHint="go" />
              <Button type="submit" variant="primary" icon={<Play />}>
                Run
              </Button>
            </div>
          </Field>
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
