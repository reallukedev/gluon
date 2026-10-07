"use client";
import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { ClockRotateRight, Cube, Folder, Page, Play, Server, Square, Code, NavArrowRight, Hashtag, Minus } from "iconoir-react";
import type { Suggestion, SuggestionKind } from "@/lib/terminal/complete";
import type { TargetId, TargetProbe } from "@/lib/terminal/types";
import { Button } from "@/components/ui/Button";
import { useSuggestions } from "./useSuggestions";
import s from "./terminal.module.css";

const KIND_ICON: Record<SuggestionKind, React.ComponentType<{ strokeWidth?: number }>> = {
  history: ClockRotateRight,
  command: Code,
  subcommand: NavArrowRight,
  option: Minus,
  folder: Folder,
  file: Page,
  container: Cube,
  unit: Server,
  value: Hashtag,
};

const KIND_WORD: Record<SuggestionKind, string> = {
  history: "Typed before",
  command: "Program",
  subcommand: "Subcommand",
  option: "Option",
  folder: "Folder",
  file: "File",
  container: "Container",
  unit: "Service",
  value: "Value",
};

export interface PromptHandle {
  focus(): void;
  fill(command: string): void;
}

interface PromptProps {
  target: TargetId;
  probe: TargetProbe | undefined;
  cwd: string | null;
  history: string[];
  running: boolean;
  disabled: boolean;
  /** The running command seems to be asking for a password: hide what's typed. */
  secret: boolean;
  label: string;
  onRun: (line: string) => void;
  onAnswer: (line: string) => void;
  onKey: (data: string) => void;
  onStop: () => void;
  onClear: () => void;
}

/**
 * The command line: type, Tab to complete, ↑ and ↓ for earlier commands, Enter to run. While a
 * command runs it becomes that command's keyboard: Enter sends a line, Ctrl-C interrupts.
 */
export const Prompt = React.forwardRef<PromptHandle, PromptProps>(function Prompt(p, ref) {
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [armed, setArmed] = React.useState(false);
  const [highlighted, setHighlighted] = React.useState<Suggestion | null>(null);
  const [histIndex, setHistIndex] = React.useState(-1);
  const draft = React.useRef("");
  const input = React.useRef<HTMLInputElement>(null);
  const caretAfter = React.useRef<number | null>(null);

  const { suggestions, loading } = useSuggestions({ target: p.target, line: value, cursor, probe: p.probe, cwd: p.cwd, history: p.history, enabled: armed && !p.running && !p.disabled });
  const open = armed && !p.running && suggestions.length > 0;

  React.useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    fill: (command: string) => {
      setValue(command);
      caretAfter.current = command.length;
      setArmed(false);
      input.current?.focus();
    },
  }));

  React.useLayoutEffect(() => {
    if (caretAfter.current === null || !input.current) return;
    const at = caretAfter.current;
    caretAfter.current = null;
    input.current.setSelectionRange(at, at);
    setCursor(at);
    // Keep the end of a long line in view after completing it.
    input.current.scrollLeft = input.current.scrollWidth;
  }, [value]);

  // Leaving a running command: the prompt is for new commands again.
  React.useEffect(() => {
    if (!p.running) setHighlighted(null);
  }, [p.running]);

  const syncCursor = () => {
    const el = input.current;
    if (el) setCursor(el.selectionStart ?? el.value.length);
  };

  function apply(sug: Suggestion) {
    setValue(sug.line);
    caretAfter.current = sug.caret;
    setHighlighted(null);
    setHistIndex(-1);
    // Keep suggesting when there's obviously more to pick (inside a folder, after a subcommand).
    setArmed(sug.kind === "folder" || sug.kind === "subcommand");
  }

  function submit() {
    const line = value;
    if (p.running) {
      p.onAnswer(line);
      setValue("");
      return;
    }
    if (!line.trim()) return;
    p.onRun(line);
    setValue("");
    setCursor(0);
    setArmed(false);
    setHistIndex(-1);
  }

  function historyStep(dir: 1 | -1) {
    if (!p.history.length) return;
    const next = Math.max(-1, Math.min(p.history.length - 1, histIndex + dir));
    if (next === histIndex) return;
    if (histIndex === -1) draft.current = value;
    const v = next === -1 ? draft.current : p.history[next]!;
    setHistIndex(next);
    setValue(v);
    caretAfter.current = v.length;
    setArmed(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) {
    if (e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (p.running) {
      if (ctrl && (e.key === "c" || e.key === "C") && !hasSelection(input.current)) {
        e.preventDefault();
        p.onKey("\x03");
        return;
      }
      if (ctrl && (e.key === "d" || e.key === "D") && !value) {
        e.preventDefault();
        p.onKey("\x04");
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.preventBaseUIHandler?.();
        submit();
      }
      return;
    }
    if (ctrl && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      p.onClear();
      return;
    }
    if (ctrl && (e.key === "c" || e.key === "C") && !hasSelection(input.current) && value) {
      // Like a shell: abandon the line.
      e.preventDefault();
      setValue("");
      setArmed(false);
      return;
    }
    if ((ctrl && e.key === " ") || (e.key === "Tab" && !e.shiftKey && !open && !value)) {
      // Ctrl-Space, or Tab on an empty line: show what's on offer.
      e.preventDefault();
      setArmed(true);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      const pick = highlighted ?? suggestions[0];
      if (open && pick) {
        e.preventDefault();
        e.preventBaseUIHandler?.();
        apply(pick);
      } else if (!open && value) {
        e.preventDefault();
        setArmed(true);
      }
      return;
    }
    if (e.key === "Escape" && !open) {
      // Nothing to close: keep what's typed (Base UI would clear it).
      e.preventBaseUIHandler?.();
      return;
    }
    if (e.key === "Enter") {
      if (open && highlighted) return; // Base UI picks the highlighted suggestion
      e.preventDefault();
      e.preventBaseUIHandler?.();
      submit();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !open) {
      e.preventDefault();
      e.preventBaseUIHandler?.();
      historyStep(e.key === "ArrowUp" ? 1 : -1);
    }
  }

  const fine = useFinePointer();
  const prompt = p.probe?.user === "root" || !p.probe ? "#" : "$";
  // Keyboard hints only where there's a keyboard; on a phone they'd be cut off and mean nothing.
  const placeholder = p.disabled ? "" : p.running ? (fine ? "Type an answer and press Enter. Ctrl-C interrupts." : "Type an answer") : fine ? "Type a command. Tab completes, ↑ goes back." : "Type a command";

  return (
    <div className={s.promptRow}>
      <Autocomplete.Root
        items={suggestions}
        filter={null}
        value={value}
        open={open}
        onOpenChange={(next, d) => {
          if (!next && d.reason !== "item-press") setArmed(false);
        }}
        onValueChange={(v, d) => {
          if (d.reason === "item-press") return;
          setValue(v);
          setHistIndex(-1);
          if (d.reason === "input-change") setArmed(!p.running && v.trim().length > 0);
        }}
        onItemHighlighted={(v) => setHighlighted((v as Suggestion | undefined) ?? null)}
        itemToStringValue={(v: Suggestion) => v.line}
        disabled={p.disabled}
      >
        <Autocomplete.InputGroup className={s.inputGroup} data-running={p.running ? "" : undefined}>
          <span className={s.sigil} aria-hidden>
            {p.running ? "›" : prompt}
          </span>
          <Autocomplete.Input
            ref={input}
            className={s.input}
            aria-label={p.running ? `Input for the running command in ${p.label}` : `Command to run in ${p.label}`}
            placeholder={placeholder}
            type={p.running && p.secret ? "password" : "text"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint={p.running ? "send" : "go"}
            maxLength={8000}
            onKeyDown={onKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            onInput={syncCursor}
          />
        </Autocomplete.InputGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner className={s.suggestPositioner} side="top" align="start" sideOffset={6} collisionPadding={8}>
            <Autocomplete.Popup className={s.suggestPopup} aria-label="Suggestions">
              <Autocomplete.List className={s.suggestList}>
                {(sug: Suggestion) => {
                  const Icon = KIND_ICON[sug.kind];
                  return (
                    <Autocomplete.Item key={`${sug.kind}:${sug.line}`} value={sug} className={s.suggestItem} onClick={() => apply(sug)}>
                      <span className={s.suggestIcon} title={KIND_WORD[sug.kind]}>
                        <Icon strokeWidth={1.6} />
                      </span>
                      <span className={s.suggestLabel}>{sug.label}</span>
                      {sug.description ? <span className={s.suggestDesc}>{sug.description}</span> : <span className="sr-only">{KIND_WORD[sug.kind]}</span>}
                    </Autocomplete.Item>
                  );
                }}
              </Autocomplete.List>
              <div className={s.suggestFoot} aria-hidden>
                <span>
                  <kbd>tab</kbd> complete
                </span>
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> choose
                </span>
                <span>
                  <kbd>esc</kbd> close
                </span>
                {loading && <span className={s.suggestLoading}>Looking…</span>}
              </div>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {p.running ? (
        <Button onClick={p.onStop} icon={<Square />} className={s.runButton}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" onClick={submit} icon={<Play />} disabled={p.disabled || !value.trim()} className={s.runButton}>
          Run
        </Button>
      )}
    </div>
  );
});

function hasSelection(el: HTMLInputElement | null) {
  return !!el && el.selectionStart !== el.selectionEnd;
}

function useFinePointer(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(pointer: fine)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(pointer: fine)").matches,
    () => true,
  );
}
