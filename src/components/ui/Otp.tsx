"use client";
import * as React from "react";
import { OTPField } from "@base-ui/react/otp-field";
import s from "./otp.module.css";

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

export function Otp({ value, onChange, onComplete, id, invalid, disabled, autoFocus, ...rest }: Props) {
  const first = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);
  return (
    <OTPField.Root
      id={id}
      length={6}
      value={value}
      onValueChange={(v) => onChange(v)}
      onValueComplete={(v) => onComplete?.(v)}
      inputMode="numeric"
      disabled={disabled}
      className={s.root}
      data-invalid={invalid ? "" : undefined}
      aria-describedby={rest["aria-describedby"]}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <React.Fragment key={i}>
          {i === 3 && <span className={s.sep} aria-hidden />}
          <OTPField.Input ref={i === 0 ? first : undefined} className={s.slot} aria-label={i === 0 ? undefined : `Digit ${i + 1} of 6`} />
        </React.Fragment>
      ))}
    </OTPField.Root>
  );
}
