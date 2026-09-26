"use client";
/**
 * InlineEdit — rename in place (a server name, a pinned folder, a route label).
 *
 *   <InlineEdit value={name} label="Server name" onSave={(v) => api.patch(..., { name: v })} />
 *
 * - Reads as plain text with a pencil that appears on hover/focus; click, tap, or Enter to edit.
 * - Enter or the tick saves; Escape or the cross cancels; leaving the field saves if it changed.
 * - `onSave` may throw (or reject): the message shows under the field and editing continues.
 * - `validate` returns an error string to block saving (shown the same way).
 * - The field is sized to its text, so switching modes does not reflow the row.
 */
import * as React from "react";
import { Check, EditPencil, Xmark } from "iconoir-react";
import { IconButton } from "./Button";
import s from "./inlineEdit.module.css";

interface InlineEditProps {
  value: string;
  onSave: (next: string) => unknown;
  /** Accessible name, e.g. "Server name". */
  label: string;
  placeholder?: string;
  validate?: (next: string) => string | null | undefined;
  mono?: boolean;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  /** Text shown when value is empty. */
  emptyText?: string;
}

export function InlineEdit({ value, onSave, label, placeholder, validate, mono, disabled, maxLength = 120, className, emptyText = "Not set" }: InlineEditProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const display = React.useRef<HTMLButtonElement>(null);
  const errorId = React.useId();

  const begin = () => {
    if (disabled) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  };
  React.useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const finish = () => {
    setEditing(false);
    setError(null);
    requestAnimationFrame(() => display.current?.focus());
  };

  const save = async () => {
    const next = draft.trim();
    if (next === value.trim()) return finish();
    const problem = validate?.(next);
    if (problem) {
      setError(problem);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        ref={display}
        type="button"
        className={`${s.display} ${mono ? "mono" : ""} ${className ?? ""}`}
        onClick={begin}
        disabled={disabled}
        aria-label={`${label}: ${value || emptyText}. Edit`}
      >
        <span className={`${s.text} ${value ? "" : s.empty}`}>{value || emptyText}</span>
        {!disabled && <EditPencil className={s.pencil} aria-hidden />}
      </button>
    );
  }

  return (
    <span className={`${s.edit} ${className ?? ""}`}>
      <span className={s.row}>
        <input
          ref={input}
          className={`${s.input} ${mono ? "mono" : ""}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              finish();
            }
          }}
          onBlur={(e) => {
            // Moving to our own buttons is not "leaving".
            if (e.relatedTarget && e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) return;
            if (!busy && !error) void save();
          }}
        />
        <IconButton label="Save" size="sm" variant="ghost" loading={busy} onClick={() => void save()} tooltip={false}>
          <Check />
        </IconButton>
        <IconButton label="Cancel" size="sm" variant="ghost" disabled={busy} onClick={finish} tooltip={false}>
          <Xmark />
        </IconButton>
      </span>
      {error && (
        <span id={errorId} className={s.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
