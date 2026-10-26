"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { useApi } from "@/lib/client/api";
import { lastTarget, saveLastTarget, takeAutorun, terminalHref, TERMINAL_RUN_EVENT } from "@/lib/terminal/palette";
import type { TargetId, TargetList, TargetProbe } from "@/lib/terminal/types";
import { Segmented } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import { CommandsMode, type CommandsHandle } from "./CommandsMode";
import { TargetPicker } from "./TargetPicker";
import { useHistory } from "./useHistory";
import type { XtermPaneProps } from "./XtermPane";
import s from "./terminal.module.css";

// xterm.js only loads here, and only once Terminal mode is first opened.
const XtermPane = dynamic<XtermPaneProps>(() => import("./XtermPane"), {
  ssr: false,
  loading: () => (
    <div className={s.termLoading}>
      <Skeleton height="100%" radius={0} />
    </div>
  ),
});

type Mode = "commands" | "terminal";

export function TerminalView({ initialTarget, initialRun, initialMode, userId }: { initialTarget: TargetId | null; initialRun: string | null; initialMode: Mode; userId: string }) {
  const [target, setTarget] = React.useState<TargetId>(initialTarget ?? "host");
  const [mode, setMode] = React.useState<Mode>(initialMode);
  const [termUsed, setTermUsed] = React.useState(initialMode === "terminal");
  const [launch, setLaunch] = React.useState<{ n: number; command: string | null }>({ n: 0, command: null });
  const [cwds, setCwds] = React.useState<Partial<Record<TargetId, string>>>({});
  const commands = React.useRef<CommandsHandle>(null);

  // No target in the link: the last one used here.
  React.useEffect(() => {
    if (initialTarget) return;
    const last = lastTarget(userId);
    if (last) setTarget(last);
  }, [initialTarget, userId]);

  const targets = useApi<TargetList>("/api/terminal/targets", { refresh: 30_000 });
  const probe = useApi<TargetProbe>(`/api/terminal/probe?target=${encodeURIComponent(target)}`, { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false, keepPreviousData: false });
  const { history, count, add, clear } = useHistory(userId, target);

  const container = target === "host" ? null : (targets.data?.groups.flatMap((g) => g.targets.map((t) => ({ t, g }))).find((x) => x.t.id === target) ?? null);
  const label = target === "host" ? "this server" : (container?.t.name ?? target.replace(/^container:/, ""));
  const hostName = targets.data?.host.name ?? "";
  const cwd = cwds[target] ?? probe.data?.cwd ?? null;

  const choose = (t: TargetId) => {
    setTarget(t);
    saveLastTarget(userId, t);
    // Keep the address shareable without a server round trip (and without resetting the page).
    window.history.replaceState(null, "", terminalHref(t));
  };

  const openTerminal = React.useCallback((command: string | null) => {
    setTermUsed(true);
    setMode("terminal");
    setLaunch((l) => ({ n: l.n + 1, command }));
  }, []);

  // ?run= fills the prompt; it only runs straight away when the palette asked for it just now.
  const [pending, setPending] = React.useState<{ command: string; auto: boolean } | null>(null);
  const handed = React.useRef<string | null>(null);
  React.useEffect(() => {
    // Once per link (effects can run twice in development; the note can only be taken once).
    const k = `${initialTarget}|${initialRun}`;
    if (!initialRun || handed.current === k) return;
    handed.current = k;
    setPending({ command: initialRun, auto: takeAutorun(initialTarget ?? "host", initialRun) });
  }, [initialRun, initialTarget]);
  // The palette, when this page is already open, hands commands over directly.
  React.useEffect(() => {
    const onRun = (e: Event) => {
      const d = (e as CustomEvent<{ target: TargetId; command: string }>).detail;
      if (!d?.command) return;
      setTarget(d.target);
      setMode("commands");
      setPending({ command: d.command, auto: true });
    };
    window.addEventListener(TERMINAL_RUN_EVENT, onRun);
    return () => window.removeEventListener(TERMINAL_RUN_EVENT, onRun);
  }, []);
  React.useEffect(() => {
    if (!pending || !probe.data || probe.isValidating) return;
    setPending(null);
    if (pending.auto) commands.current?.run(pending.command);
    else commands.current?.fill(pending.command);
  }, [pending, probe.data, probe.isValidating]);

  const probeError = probe.error ? probe.error.message : null;
  const who = probe.data ? ` as ${probe.data.user}` : "";
  const summary =
    mode === "terminal" ? (
      <>
        A shell {target === "host" ? <>on <b>this server</b></> : <>in <b>{label}</b></>}
        {who}. It closes after an hour without typing.
      </>
    ) : target === "host" ? (
      <>
        Commands run on <b>this server</b>
        {hostName ? ` (${hostName})` : ""}
        {who}. They&apos;re recorded in Activity.
      </>
    ) : (
      <>
        Commands run in <b>{label}</b>
        {container ? `, part of ${container.g.name},` : ""}
        {who}. They&apos;re recorded in Activity.
      </>
    );

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.headText}>
          <h1 className={s.title}>Terminal</h1>
          <p className={s.summary}>{summary}</p>
        </div>
        <div className={s.headActions}>
          <TargetPicker list={targets.data} value={target} onChange={choose} hostName={hostName} />
          <Segmented<Mode>
            aria-label="How to run commands"
            value={mode}
            onChange={(m) => {
              if (m === "terminal") setTermUsed(true);
              setMode(m);
            }}
            options={[
              { value: "commands", label: "Commands" },
              { value: "terminal", label: "Terminal" },
            ]}
          />
        </div>
      </header>

      <div className={s.workspace}>
        <CommandsMode
          ref={commands}
          active={mode === "commands"}
          target={target}
          label={label}
          probe={probe.data}
          probeError={probeError}
          cwd={cwd}
          onCwd={(t, c) => setCwds((m) => ({ ...m, [t]: c }))}
          history={history}
          historyCount={count}
          onRemember={add}
          onForget={(which) => clear(which === "all" ? "all" : target)}
          onOpenTerminal={openTerminal}
        />
        {termUsed && <XtermPane target={target} label={label} cwd={cwd} active={mode === "terminal"} launch={launch} />}
      </div>
    </div>
  );
}
