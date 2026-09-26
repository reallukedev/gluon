"use client";
import * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { useKeyboardOpen } from "./Menu";
import s from "./popup.module.css";

interface Props {
  trigger: React.ReactElement<Record<string, unknown>>;
  title?: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  openOnHover?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ trigger, title, children, side = "bottom", align = "center", openOnHover, className, open, onOpenChange }: Props) {
  const [kbd, trackKeyboard] = useKeyboardOpen();
  return (
    <BasePopover.Root
      open={open}
      onOpenChange={(o, d) => {
        trackKeyboard(o, d);
        onOpenChange?.(o);
      }}
    >
      <BasePopover.Trigger render={trigger} openOnHover={openOnHover} delay={300} />
      <BasePopover.Portal>
        <BasePopover.Positioner className={s.positioner} side={side} align={align} sideOffset={8} collisionPadding={8}>
          <BasePopover.Popup className={`${s.popup} ${s.popover} ${className ?? ""}`} data-keyboard={kbd ? "" : undefined} data-motion-gentle="">
            {title && <BasePopover.Title className={s.popoverTitle}>{title}</BasePopover.Title>}
            <div className={s.popoverText}>{children}</div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
