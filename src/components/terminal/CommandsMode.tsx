"use client";
import * as React from "react";
import { MoreHoriz } from "iconoir-react";
import { AnsiScreen } from "@/lib/terminal/ansi";
import { interactiveProgram, type Interactive } from "@/lib/terminal/interactive";
import { shortPath } from "@/lib/terminal/paths";
import type { TargetId, TargetProbe } from "@/lib/terminal/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Notice } from "@/components/ui/Surface";
import { LiveSession } from "./session";
import { Prompt, type PromptHandle } from "./Prompt";
import { RunBlock, type Block } from "./RunBlock";
import s from "./terminal.module.css";

export interface CommandsHandle {
  run(command: string): void;
  fill(command: string): void;
}

interface Props {
  target: TargetId;
  label: string;
  probe: TargetProbe | undefined;
  probeError: string | null;
  cwd: string | null;
  onCwd: (target: TargetId, cwd: string) => void;
  history: string[];
  historyCount: number;
  onRemember: (target: TargetId, command: string) => void;
  onForget: (which: "target" | "all") => void;
  onOpenTerminal: (command: string | null) => void;
  active: boolean;
}

const MAX_BLOCKS = 60;

const EXAMPLES_HOST = ["df -h", "docker ps", "systemctl --failed", "free -h", "journalctl -p err -b --no-pager | tail -20"];
const EXAMPLES_CONTAINER = ["ls -la", "cat /etc/os-release", "ps aux", "env | sort", "df -h"];

/** Commands mode: one prompt, each run a block with its output, the folder carried between runs. */
export const CommandsMode = React.forwardRef<CommandsHandle, Props>(function CommandsMode(p, ref) {
  // Callbacks read the latest props through this, so they stay stable for the memoised blocks.
  const latest = React.useRef(p);
  latest.current = p;
  const blocks = React.useRef<Block[]>([]);
  const sessions = React.useRef(new Map<number, LiveSession>());
  const [, render] = React.useReducer((n: number) => n + 1, 0);
  const [ask, setAsk] = React.useState<{ command: string; hit: Interactive } | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const measure = React.useRef<HTMLSpanElement>(null);
  const prompt = React.useRef<PromptHandle>(null);
  const atBottom = React.useRef(true);
  const frame = React.useRef<number | null>(null);
  const nextKey = React.useRef(1);

  /** Blocks are replaced, not changed in place, so a memoised block redraws when its state moves. */
  const patchBlock = (key: number, patch: Partial<Block>) => {
    blocks.current = blocks.current.map((x) => (x.key === key ? { ...x, ...patch } : x));
    render();
  };

  const running = blocks.current.find((b) => b.state === "running") ?? null;
  const runningSession = running ? sessions.current.get(running.key) : undefined;
  const [secret, setSecret] = React.useState(false);

  // Output arrives in bursts: draw at most once a frame.
  const schedule = React.useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      render();
    });
  }, []);

  React.useEffect(
    () => () => {
      for (const sess of sessions.current.values()) sess.close();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // Follow new output while the reader is at the bottom.
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  const size = React.useCallback(() => {
    const el = scroller.current;
    const m = measure.current;
    const charW = m ? m.getBoundingClientRect().width / 20 : 8;
    const width = el ? el.clientWidth - 36 : 640;
    return { cols: Math.max(20, Math.min(400, Math.floor(width / (charW || 8)))), rows: 40 };
  }, []);

  // Tell a running command when the space it has changes (wrapping tables, progress bars).
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const { rows, cols } = size();
      const k = `${rows}x${cols}`;
      if (k === last) return;
      last = k;
      for (const sess of sessions.current.values()) sess.resize(rows, cols);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  const start = React.useCallback(
    (command: string, target: TargetId, where: string, cwd: string, home: string | null) => {
      const key = nextKey.current++;
      const { rows, cols } = size();
      const screen = new AnsiScreen(rows);
      const b: Block = { key, target, where, cwd, home, command, screen, state: "running", exit: null, error: null, startedAt: Date.now(), stopping: false };
      blocks.current = [...blocks.current, b].slice(-MAX_BLOCKS);
      atBottom.current = true;
      latest.current.onRemember(target, command);
      const update = (patch: Partial<Block>) => patchBlock(key, patch);
      const sess = new LiveSession(
        { target, mode: "run", command, cwd, rows, cols },
        {
          onOut: (data) => {
            screen.write(data);
            // A prompt for a password: hide what's typed in answer.
            setSecret(/(password|passphrase|passcode)[^\n]*:\s*$/i.test(screen.currentLine()));
            schedule();
          },
          onExit: (e) => {
            sessions.current.delete(key);
            setSecret(false);
            if (e.cwd) latest.current.onCwd(target, e.cwd);
            const state = e.reason === "done" ? (e.code === 0 ? "ok" : "failed") : "stopped";
            update({ state, exit: { code: e.code, ms: e.ms, truncated: e.truncated, reason: e.reason }, stopping: false });
          },
          onError: (message, code) => {
            sessions.current.delete(key);
            setSecret(false);
            if (code === "reauth_cancelled" || code === "aborted") {
              blocks.current = blocks.current.filter((x) => x.key !== key);
              render();
              return;
            }
            update({ state: "error", error: message, stopping: false });
          },
        },
      );
      sessions.current.set(key, sess);
      render();
    },
    [schedule, size],
  );

  const run = React.useCallback(
    (command: string, force = false) => {
      const c = command.trim();
      if (!c || !p.probe || !p.cwd) return;
      if (blocks.current.some((b) => b.state === "running")) return;
      const hit = force ? null : interactiveProgram(c);
      if (hit) {
        setAsk({ command: c, hit });
        return;
      }
      setAsk(null);
      start(c, p.target, p.label, p.cwd, p.probe.home);
    },
    [p.probe, p.cwd, p.target, p.label, start],
  );

  React.useImperativeHandle(ref, () => ({ run: (c) => run(c), fill: (c) => prompt.current?.fill(c) }), [run]);

  const clear = React.useCallback(() => {
    blocks.current = blocks.current.filter((b) => b.state === "running");
    render();
  }, []);

  const onStop = React.useCallback((b: Block) => {
    const sess = sessions.current.get(b.key);
    if (!sess) return;
    patchBlock(b.key, { stopping: true });
    void sess.stop();
  }, []);

  const onAgain = React.useCallback(
    (b: Block) => {
      if (blocks.current.some((x) => x.state === "running")) return;
      start(b.command, b.target, b.where, b.cwd, b.home);
    },
    [start],
  );

  const onOpenTerminal = React.useCallback((b: Block) => {
    const sess = sessions.current.get(b.key);
    if (sess) void sess.stop();
    latest.current.onOpenTerminal(b.command);
  }, []);

  const list = blocks.current;
  const examples = p.target === "host" ? EXAMPLES_HOST : EXAMPLES_CONTAINER;
  const ready = !!p.probe && !!p.cwd;

  return (
    <div className={s.commands} hidden={!p.active}>
      <div
        className={s.blocks}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <span ref={measure} className={s.measure} aria-hidden>
          00000000000000000000
        </span>
        {list.length === 0 ? (
          <div className={s.intro}>
            <p className={s.introTitle}>{p.target === "host" ? "Run a command on this server" : `Run a command in ${p.label}`}</p>
            <p className={s.introText}>
              Commands go through a shell, so pipes, variables and <code>cd</code> work. Tab completes names, folders and options. Programs that need the whole screen, like <code>top</code> or <code>vim</code>, open in the terminal.
            </p>
            <ul className={s.examples} aria-label="Try one">
              {examples.map((ex) => (
                <li key={ex}>
                  <button type="button" className={s.example} onClick={() => prompt.current?.fill(ex)} disabled={!ready}>
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          list.map((b) => <RunBlock key={b.key} block={b} version={b.screen.version} onStop={onStop} onAgain={onAgain} onOpenTerminal={onOpenTerminal} />)
        )}
      </div>

      <div className={s.dock}>
        {ask && (
          <div className={s.askRow}>
            <Notice
              tone="neutral"
              title={ask.hit.reason === "screen" ? `${ask.hit.program} needs the whole screen` : `${ask.hit.program} waits for you to type`}
              action={
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      p.onRemember(p.target, ask.command);
                      setAsk(null);
                      p.onOpenTerminal(ask.command);
                    }}
                  >
                    Open in the terminal
                  </Button>
                  <Button size="sm" onClick={() => run(ask.command, true)}>
                    Run here anyway
                  </Button>
                </>
              }
            >
              {ask.hit.reason === "screen" ? "It can't draw itself in a command block. The terminal shows it properly." : "The terminal handles that best. Here, you'd answer it one line at a time."}
            </Notice>
          </div>
        )}
        {p.probeError ? (
          <div className={s.askRow}>
            <Notice tone="fault" title={`Commands can't run in ${p.label}`}>
              {p.probeError}
            </Notice>
          </div>
        ) : null}
        <div className={s.dockHead}>
          <span className={s.dockCwd} title={p.cwd ?? undefined}>
            {p.cwd ? shortPath(p.cwd, p.probe?.home ?? null) : " "}
          </span>
          <span className={s.dockWho}>{p.probe ? `${p.probe.user} · ${p.probe.shell.replace(/^.*\//, "")}` : ""}</span>
          <Menu
            trigger={
              <IconButton size="sm" label="More">
                <MoreHoriz />
              </IconButton>
            }
            items={[
              { label: "Clear the screen", hint: "Ctrl-L", disabled: !list.some((b) => b.state !== "running"), onSelect: clear },
              "separator",
              { label: `Forget commands typed in ${p.target === "host" ? "this server" : p.label}`, disabled: !p.history.length, onSelect: () => p.onForget("target") },
              { label: "Forget every command typed here", description: "History is kept in this browser only", disabled: !p.historyCount, onSelect: () => p.onForget("all") },
            ]}
          />
        </div>
        <Prompt
          ref={prompt}
          target={p.target}
          probe={p.probe}
          cwd={p.cwd}
          history={p.history}
          running={!!running}
          disabled={!ready && !running}
          secret={secret}
          label={p.target === "host" ? "this server" : p.label}
          onRun={(line) => run(line)}
          onAnswer={(line) => runningSession?.send(`${line}\r`)}
          onKey={(d) => runningSession?.send(d)}
          onStop={() => running && onStop(running)}
          onClear={clear}
        />
      </div>
    </div>
  );
});
