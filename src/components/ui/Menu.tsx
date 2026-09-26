"use client";
import * as React from "react";
import Link from "next/link";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Check, NavArrowRight } from "iconoir-react";
import s from "./popup.module.css";

export interface MenuAction {
  kind?: "item";
  label: string;
  description?: string;
  icon?: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  onSelect?: () => void;
}
export interface MenuCheck {
  kind: "check";
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}
export interface MenuSub {
  kind: "sub";
  label: string;
  icon?: React.ReactNode;
  items: MenuEntry[];
}
export type MenuEntry = MenuAction | MenuCheck | MenuSub | "separator" | { kind: "label"; label: string };

function Entries({ items, parts }: { items: MenuEntry[]; parts: typeof BaseMenu | typeof BaseContextMenu }) {
  const P = parts as typeof BaseMenu;
  return (
    <>
      {items.map((it, i) => {
        if (it === "separator") return <P.Separator key={i} className={s.separator} />;
        if (it.kind === "label") return <div key={i} className={`label ${s.groupLabel}`}>{it.label}</div>;
        if (it.kind === "check") {
          return (
            <P.CheckboxItem key={i} className={s.item} checked={it.checked} onCheckedChange={it.onChange}>
              <span className={s.itemText}>{it.label}</span>
              <P.CheckboxItemIndicator className={s.check}>
                <Check strokeWidth={2} />
              </P.CheckboxItemIndicator>
            </P.CheckboxItem>
          );
        }
        if (it.kind === "sub") {
          return (
            <P.SubmenuRoot key={i}>
              <P.SubmenuTrigger className={s.item}>
                {it.icon}
                <span className={s.itemText}>{it.label}</span>
                <NavArrowRight className={s.subArrow} />
              </P.SubmenuTrigger>
              <P.Portal>
                <P.Positioner className={s.positioner} sideOffset={-4} alignOffset={-5}>
                  <P.Popup className={s.popup} data-motion-gentle="">
                    <Entries items={it.items} parts={parts} />
                  </P.Popup>
                </P.Positioner>
              </P.Portal>
            </P.SubmenuRoot>
          );
        }
        const content = (
          <>
            {it.icon}
            <span className={s.itemText}>
              {it.label}
              {it.description && <span className={s.itemDesc}>{it.description}</span>}
            </span>
            {it.hint && <span className={s.itemHint}>{it.hint}</span>}
          </>
        );
        if (it.href && !it.disabled) {
          const external = /^[a-z]+:\/\//i.test(it.href);
          return (
            <P.LinkItem
              key={i}
              className={`${s.item} ${it.danger ? s.danger : ""}`}
              closeOnClick
              onClick={it.onSelect}
              render={external ? <a href={it.href} target="_blank" rel="noopener noreferrer" /> : <Link href={it.href} />}
            >
              {content}
            </P.LinkItem>
          );
        }
        return (
          <P.Item key={i} className={`${s.item} ${it.danger ? s.danger : ""}`} disabled={it.disabled} onClick={it.onSelect}>
            {content}
          </P.Item>
        );
      })}
    </>
  );
}

interface MenuProps {
  trigger: React.ReactElement<Record<string, unknown>>;
  items: MenuEntry[];
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  modal?: boolean;
}

/** Popups opened from the keyboard appear instantly (keyboard actions never animate). */
export function useKeyboardOpen() {
  const [kbd, setKbd] = React.useState(false);
  const onOpenChange = React.useCallback((open: boolean, d: { event?: Event }) => {
    if (open) setKbd(typeof KeyboardEvent !== "undefined" && d.event instanceof KeyboardEvent);
  }, []);
  return [kbd, onOpenChange] as const;
}

export function Menu({ trigger, items, align = "end", side = "bottom", modal = false }: MenuProps) {
  const [kbd, onOpenChange] = useKeyboardOpen();
  return (
    <BaseMenu.Root modal={modal} onOpenChange={onOpenChange}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className={s.positioner} align={align} side={side} sideOffset={6} collisionPadding={8}>
          <BaseMenu.Popup className={s.popup} data-keyboard={kbd ? "" : undefined} data-motion-gentle="">
            <Entries items={items} parts={BaseMenu} />
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function ContextMenu({ items, children, disabled }: { items: MenuEntry[]; children: React.ReactElement<Record<string, unknown>>; disabled?: boolean }) {
  if (disabled) return children;
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger render={children} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className={s.positioner} collisionPadding={8}>
          <BaseContextMenu.Popup className={s.popup} data-motion-gentle="">
            <Entries items={items} parts={BaseContextMenu as unknown as typeof BaseMenu} />
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}
