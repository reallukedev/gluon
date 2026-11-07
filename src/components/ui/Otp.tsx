"use client";
import * as React from "react";
import s from "./otp.module.css";

const LENGTH = 6;

interface Props {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-describedby"?: string;
}

/**
 * A six-digit code entry drawn as separate boxes but backed by one real input.
 *
 * Password managers (Bitwarden in particular) look for a single visible text field
 * with `autocomplete="one-time-code"` or a TOTP-ish id/name. Six separate inputs
 * with generated ids and `autocomplete="off"` on all but the first don't qualify,
 * so the boxes here are decoration and the input sits on top of them, transparent.
 * It has to stay on top and above 0.1 opacity: Bitwarden skips fields that are
 * covered at their centre point or near-invisible.
 */
export function Otp({ value, onChange, onComplete, id, invalid, disabled, autoFocus, ...rest }: Props) {
  const ref = React.useRef<HTMLInputElement>(null);
  const autoId = React.useId();
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const toEnd = () => {
    const el = ref.current;
    if (el && (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length)) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  const active = focused ? Math.min(value.length, LENGTH - 1) : -1;

  return (
    <div className={s.root} data-invalid={invalid ? "" : undefined} data-disabled={disabled ? "" : undefined}>
      <input
        ref={ref}
        id={id ?? `totp-${autoId.replace(/:/g, "")}`}
        name="totp"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={LENGTH}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        aria-label="6-digit code"
        aria-invalid={invalid || undefined}
        aria-describedby={rest["aria-describedby"]}
        disabled={disabled}
        className={s.input}
        value={value}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, "").slice(0, LENGTH);
          if (next === value) return;
          onChange(next);
          if (next.length === LENGTH) onComplete?.(next);
        }}
        onFocus={() => {
          setFocused(true);
          requestAnimationFrame(toEnd);
        }}
        onBlur={() => setFocused(false)}
        onSelect={toEnd}
      />
      {Array.from({ length: LENGTH }, (_, i) => (
        <React.Fragment key={i}>
          {i === 3 && <span className={s.sep} aria-hidden />}
          <span className={s.slot} data-active={i === active ? "" : undefined} aria-hidden>
            {value[i] ?? (i === active ? <span className={s.caret} /> : null)}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
