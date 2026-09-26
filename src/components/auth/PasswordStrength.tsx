"use client";
import * as React from "react";
import { passwordStrength } from "./strength";
import s from "./parts.module.css";

/**
 * Four hairline ticks and a plain word. Advice, never a gate: any password is accepted. Announced
 * politely (only the label) so screen readers aren't interrupted on every keystroke.
 */
export function PasswordStrength({ value, context = [], id }: { value: string; context?: string[]; id?: string }) {
  const deferred = React.useDeferredValue(value);
  const ctxKey = context.join("\u0000");
  const st = React.useMemo(() => passwordStrength(deferred, ctxKey ? ctxKey.split("\u0000") : []), [deferred, ctxKey]);
  if (!value) return null;
  return (
    <div className={s.strength} id={id}>
      <span className={s.ticks} aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} data-on={st.score > i || (st.score === 0 && i === 0) ? "" : undefined} data-motion-gentle="" />
        ))}
      </span>
      <span className={s.strengthLabel} aria-live="polite">
        {st.label}
      </span>
      {st.hint && <span className={s.strengthHint}>{st.hint}</span>}
    </div>
  );
}
