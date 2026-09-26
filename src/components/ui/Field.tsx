"use client";
import * as React from "react";
import { Field as BaseField } from "@base-ui/react/field";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import { Check, Minus } from "iconoir-react";
import s from "./field.module.css";

interface FieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** Label + control + description/error, wired for accessibility by Base UI Field. */
export function Field({ label, description, error, optional, children, className }: FieldProps) {
  return (
    <BaseField.Root invalid={!!error} className={`${s.field} ${className ?? ""}`}>
      <BaseField.Label className={s.label}>
        {label}
        {optional && <span className={s.optional}>optional</span>}
      </BaseField.Label>
      {children}
      {description && !error && <BaseField.Description className={s.description}>{description}</BaseField.Description>}
      {error && (
        <BaseField.Error className={s.error} match>
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  );
}

type InputProps = React.ComponentPropsWithoutRef<"input"> & { mono?: boolean };

/** Use inside <Field> (becomes its control) or on its own with an aria-label. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, mono, ...rest }, ref) {
  return <BaseField.Control ref={ref} className={`${s.input} ${mono ? s.mono : ""} ${className ?? ""}`} {...rest} />;
});

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<"textarea"> & { mono?: boolean }>(function TextArea(
  { className, mono, ...rest },
  ref,
) {
  return <BaseField.Control render={<textarea ref={ref} />} className={`${s.input} ${mono ? s.mono : ""} ${className ?? ""}`} {...(rest as object)} />;
});

/** An input with fixed text before/after it, e.g. `https://` [ photos ] `.example.com`. */
export function AffixInput({ before, after, ...rest }: InputProps & { before?: React.ReactNode; after?: React.ReactNode }) {
  return (
    <div className={s.affix}>
      {before && <span className={s.affixPart}>{before}</span>}
      <Input {...rest} />
      {after && <span className={s.affixPart}>{after}</span>}
    </div>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function Switch({ checked, onChange, disabled, id, ...aria }: SwitchProps) {
  return (
    <BaseSwitch.Root id={id} checked={checked} onCheckedChange={(c) => onChange(c)} disabled={disabled} className={s.switch} nativeButton render={<button type="button" />} {...aria}>
      <BaseSwitch.Thumb className={s.thumb} data-motion-gentle="" />
    </BaseSwitch.Root>
  );
}

/** A settings row: label + description on the left, a control (switch, select…) on the right. */
export function SettingRow({ label, description, children, stack }: { label: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; stack?: boolean }) {
  const id = React.useId();
  return (
    <div className={`${s.row} ${stack ? s.stack : ""}`} role="group" aria-labelledby={id}>
      <div className={s.rowText}>
        <div id={id} className={s.rowLabel}>
          {label}
        </div>
        {description && <div className={s.rowDesc}>{description}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (c: boolean) => void;
  children?: React.ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  const box = (
    <BaseCheckbox.Root checked={checked} indeterminate={indeterminate} onCheckedChange={(c) => onChange(c)} disabled={disabled} className={s.checkbox}>
      <BaseCheckbox.Indicator>{indeterminate ? <Minus strokeWidth={2.4} /> : <Check strokeWidth={2.4} />}</BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
  if (!children) return box;
  return (
    <label className={s.checkRow}>
      {box}
      <span>{children}</span>
    </label>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: React.ReactNode; icon?: React.ReactNode; ariaLabel?: string; disabled?: boolean }[];
  "aria-label": string;
  block?: boolean;
  disabled?: boolean;
}

/**
 * A sunk well of choices. The raised plate slides to the chosen segment (200ms, --ease-in-out:
 * it is moving on screen) so the eye follows the change; keyboard changes land instantly.
 * Before hydration the chosen segment draws its own plate, so there is no flash.
 */
export function Segmented<T extends string>({ value, onChange, options, block, disabled, ...aria }: SegmentedProps<T>) {
  const root = React.useRef<HTMLDivElement>(null);
  const thumb = React.useRef<HTMLSpanElement>(null);
  const [ready, setReady] = React.useState(false);
  const [keyboard, setKeyboard] = React.useState(false);

  React.useLayoutEffect(() => {
    const r = root.current;
    const t = thumb.current;
    if (!r || !t) return;
    const place = () => {
      const el = r.querySelector<HTMLElement>("[data-pressed]");
      if (!el) {
        t.style.opacity = "0";
        return;
      }
      t.style.opacity = "";
      t.style.width = `${el.offsetWidth}px`;
      t.style.transform = `translateX(${el.offsetLeft}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(r);
    return () => ro.disconnect();
  }, [value]);

  // Turn on transitions only after the first placement (no slide-in on load).
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <ToggleGroup
      ref={root}
      value={[value]}
      onValueChange={(v) => {
        const next = v[0];
        if (next) onChange(next as T);
      }}
      disabled={disabled}
      className={`${s.segmented} ${block ? s.segmentedBlock : ""}`}
      aria-label={aria["aria-label"]}
      data-ready={ready ? "" : undefined}
      data-keyboard={keyboard ? "" : undefined}
      onPointerDown={() => setKeyboard(false)}
      onKeyDown={() => setKeyboard(true)}
    >
      <span ref={thumb} className={s.segmentThumb} aria-hidden data-motion-gentle="" />
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} className={s.segment} aria-label={o.ariaLabel} disabled={o.disabled}>
          {o.icon}
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
