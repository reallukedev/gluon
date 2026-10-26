"use client";
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Copy, Refresh, Xmark } from "iconoir-react";
import type { TargetId } from "@/lib/terminal/types";
import { exitMeaning } from "@/lib/terminal/exit";
import { copyText } from "@/lib/client/clipboard";
import { Button, IconButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import { LiveSession } from "./session";
import { readTheme } from "./xtermTheme";
import s from "./terminal.module.css";

export interface XtermPaneProps {
  target: TargetId;
  label: string;
  cwd: string | null;
  active: boolean;
  /** Bumped to start a fresh session, optionally typing a command into it. */
  launch: { n: number; command: string | null };
}

type Phase = { kind: "idle" } | { kind: "connecting" } | { kind: "open"; shell: string } | { kind: "ended"; code: number | null; reason: string } | { kind: "error"; message: string };

const KEYS: { label: string; aria: string; seq: string }[] = [
  { label: "esc", aria: "Escape", seq: "\x1b" },
  { label: "tab", aria: "Tab", seq: "\t" },
  { label: "^C", aria: "Control C", seq: "\x03" },
  { label: "^D", aria: "Control D", seq: "\x04" },
  { label: "←", aria: "Left", seq: "\x1b[D" },
  { label: "↑", aria: "Up", seq: "\x1b[A" },
  { label: "↓", aria: "Down", seq: "\x1b[B" },
  { label: "→", aria: "Right", seq: "\x1b[C" },
];

/** Terminal mode: a real shell in xterm.js, sized to the pane, coloured from the theme. */
export default function XtermPane({ target, label, cwd, active, launch }: XtermPaneProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const term = React.useRef<Terminal | null>(null);
  const fit = React.useRef<FitAddon | null>(null);
  const sess = React.useRef<LiveSession | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [ready, setReady] = React.useState(false);
  const cwdRef = React.useRef(cwd);
  cwdRef.current = cwd;

  // The terminal itself: made once, themed from the page, refitted whenever its box changes.
  React.useEffect(() => {
    const el = host.current!;
    const { theme, fontFamily } = readTheme(el);
    const t = new Terminal({ theme, fontFamily, fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, macOptionIsMeta: true, rightClickSelectsWord: true, allowProposedApi: false });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
    t.open(el);
    term.current = t;
    fit.current = f;
    const refit = () => {
      if (el.offsetParent === null || el.clientWidth < 40) return;
      try {
        f.fit();
      } catch {
        /* not laid out yet */
      }
    };
    refit();
    void document.fonts?.ready.then(() => {
      t.options.fontFamily = readTheme(el).fontFamily;
      refit();
    });
    setReady(true);

    t.onData((d) => sess.current?.send(d));
    t.onResize(({ rows, cols }) => sess.current?.resize(rows, cols));
    t.attachCustomKeyEventHandler((e) => {
      // Ctrl-Shift-C copies (Ctrl-C belongs to the program); Cmd-C works as usual on a Mac.
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const text = t.getSelection();
        if (text) void copyText(text);
        return false;
      }
      return true;
    });
    // Ctrl-K and friends belong to the shell here, not to Gluon's own shortcuts.
    const stopCtrl = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    el.addEventListener("keydown", stopCtrl);

    const ro = new ResizeObserver(refit);
    ro.observe(el);
    // Follow the theme: light, dark, contrast and colour choices all change the tokens.
    const retheme = () => {
      t.options.theme = readTheme(el).theme;
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast", "data-attn"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", retheme);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", retheme);
      el.removeEventListener("keydown", stopCtrl);
      sess.current?.close();
      t.dispose();
      term.current = null;
    };
  }, []);

  const startSession = React.useCallback(
    (command: string | null) => {
      const t = term.current;
      if (!t) return;
      sess.current?.close();
      t.reset();
      setPhase({ kind: "connecting" });
      let sent = false;
      const sessn = new LiveSession(
        { target, mode: "shell", cwd: cwdRef.current, rows: t.rows, cols: t.cols },
        {
          onOpen: (e) => {
            if (sess.current !== sessn) return;
            setPhase({ kind: "open", shell: e.shell.replace(/^.*\//, "") });
            if (command && !sent) {
              sent = true;
              sessn.send(`${command}\r`);
            }
          },
          onOut: (d) => {
            if (sess.current === sessn) t.write(d);
          },
          onExit: (e) => {
            if (sess.current !== sessn) return;
            setPhase({ kind: "ended", code: e.code, reason: e.reason });
            t.write("\r\n");
          },
          onError: (message, code) => {
            if (sess.current !== sessn) return;
            setPhase(code === "reauth_cancelled" ? { kind: "error", message: "It wasn't opened, because you cancelled confirming it's you." } : { kind: "error", message });
          },
        },
      );
      sess.current = sessn;
      t.focus();
    },
    [target],
  );

  // Open a session the first time the pane is shown, and again for each new launch or target.
  const opened = React.useRef<string | null>(null);
  // Another target picked while the terminal is hidden: end the old shell now, not later.
  React.useEffect(() => {
    if (!opened.current || opened.current.startsWith(`${target}|`)) return;
    sess.current?.close();
    sess.current = null;
    opened.current = null;
    term.current?.reset();
    setPhase({ kind: "idle" });
  }, [target]);
  React.useEffect(() => {
    if (!ready || !active) return;
    const key = `${target}|${launch.n}`;
    if (opened.current === key) return;
    opened.current = key;
    fit.current?.fit();
    startSession(launch.command);
  }, [ready, active, target, launch, startSession]);

  // Coming back to the pane: refit (it may have been resized while hidden) and take the keyboard.
  React.useEffect(() => {
    if (!active || !ready) return;
    const id = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* hidden */
      }
      term.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, ready]);

  const live = phase.kind === "open" || phase.kind === "connecting";
  const line = phase.kind === "open" ? "running" : phase.kind === "connecting" ? "starting" : phase.kind === "error" ? "unhealthy" : "stopped";
  const where = target === "host" ? "this server" : label;
  const status =
    phase.kind === "open"
      ? `Connected to ${where} · ${phase.shell}`
      : phase.kind === "connecting"
        ? `Connecting to ${where}…`
        : phase.kind === "ended"
          ? phase.reason === "idle"
            ? "Closed after an hour without typing"
            : phase.reason === "closed"
              ? "Closed"
              : `The shell ended${phase.code ? ` with exit code ${phase.code}${exitMeaning(phase.code) ? `: ${exitMeaning(phase.code)}` : ""}` : ""}`
          : phase.kind === "error"
            ? phase.message
            : "";

  const send = (seq: string) => {
    sess.current?.send(seq);
    term.current?.focus();
  };

  return (
    <div className={s.termPane} hidden={!active}>
      <div className={s.termBar}>
        <StateLine state={line} />
        <span className={s.termStatus} role="status" title={status}>
          {status}
        </span>
        <div className={s.termActions}>
          <IconButton
            size="sm"
            label="Copy selection"
            shortcut="Ctrl Shift C"
            onClick={() => {
              const text = term.current?.getSelection() ?? "";
              if (!text) return toast.info("Select some text in the terminal first.");
              void copyText(text).then((ok) => (ok ? toast.success("Copied") : toast.error("Couldn't copy.")));
            }}
          >
            <Copy />
          </IconButton>
          {live ? (
            <Button size="sm" variant="ghost" icon={<Xmark />} onClick={() => void sess.current?.stop()}>
              End
            </Button>
          ) : (
            <Button size="sm" icon={<Refresh />} onClick={() => startSession(null)} disabled={phase.kind === "idle"}>
              New session
            </Button>
          )}
        </div>
      </div>
      <div className={s.termHost} ref={host} data-ended={live ? undefined : ""} />
      <div className={s.keyBar} role="toolbar" aria-label="Keys">
        {KEYS.map((k) => (
          <button key={k.label} type="button" className={s.key} aria-label={k.aria} onMouseDown={(e) => e.preventDefault()} onClick={() => send(k.seq)} disabled={phase.kind !== "open"}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
