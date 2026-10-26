"use client";
import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, NavArrowDown } from "iconoir-react";
import { useKeyboardOpen } from "./Menu";
import s from "./popup.module.css";

export interface Option<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly Option<T>[];
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}

export function Select<T extends string>({ value, onChange, options, id, disabled, placeholder, className, ...rest }: Props<T>) {
  const [kbd, trackKeyboard] = useKeyboardOpen();
  const items = React.useMemo(() => Object.fromEntries(options.map((o) => [o.value, o.label])), [options]);
  return (
    <BaseSelect.Root value={value} onValueChange={(v) => v !== null && onChange(v as T)} items={items} disabled={disabled} onOpenChange={trackKeyboard}>
      <BaseSelect.Trigger id={id} className={`${s.selectTrigger} ${className ?? ""}`} aria-label={rest["aria-label"]}>
        <BaseSelect.Value className={s.selectValue} placeholder={placeholder} />
        <BaseSelect.Icon className={s.selectIcon}>
          <NavArrowDown strokeWidth={2} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className={s.positioner} sideOffset={6} alignItemWithTrigger={false} collisionPadding={8}>
          <BaseSelect.Popup className={`${s.popup} ${s.selectPopup}`} data-keyboard={kbd ? "" : undefined} data-motion-gentle="">
            <BaseSelect.List>
              {options.map((o) => (
                <BaseSelect.Item key={o.value} value={o.value} className={`${s.item} ${s.selectItem}`}>
                  <BaseSelect.ItemIndicator className={s.selectIndicator}>
                    <Check strokeWidth={2.2} />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText>
                    {o.label}
                    {o.description && <span className={s.itemDesc}>{o.description}</span>}
                  </BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
