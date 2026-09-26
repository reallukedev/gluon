"use client";
import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import s from "./popup.module.css";

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseTooltip.Provider delay={450} closeDelay={80} timeout={500}>
      {children}
    </BaseTooltip.Provider>
  );
}

interface Props {
  content: React.ReactNode;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement<Record<string, unknown>>;
  disabled?: boolean;
}

/** Supplementary label for pointer users. Never the only place important information lives. */
export function Tooltip({ content, shortcut, side = "top", children, disabled }: Props) {
  if (disabled) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} collisionPadding={8} className={s.positioner}>
          <BaseTooltip.Popup className={s.tooltip} data-motion-gentle="">
            {content}
            {shortcut && <kbd>{shortcut}</kbd>}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
