"use client";
/**
 * Disclosure — "Details", "Advanced", "Show output": a quiet row that opens a section in place.
 *
 *   <Disclosure summary="Advanced">…</Disclosure>
 *   <Disclosure summary="Show output" meta="42 lines" defaultOpen>…</Disclosure>
 *   <Disclosure summary="Recent log" open={open} onOpenChange={setOpen} variant="panel">…</Disclosure>
 *
 * - Built on Base UI Collapsible (keyboard, aria-expanded/controls come for free).
 * - The panel grows to its measured height in 200ms on --ease-out and its content fades in; the
 *   chevron turns 90°. Closing is 150ms. Height is the one layout property we animate, because an
 *   accordion has no transform equivalent. Reduced motion: no height travel, only the fade.
 * - Contents stay findable with the browser's find-in-page while closed (`hidden="until-found"`).
 * - `variant="panel"`: a full-width row with a hairline above, for use inside a Panel.
 */
import * as React from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { NavArrowRight } from "iconoir-react";
import s from "./disclosure.module.css";

interface DisclosureProps {
  summary: React.ReactNode;
  /** Muted text on the right of the summary (e.g. a count). */
  meta?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "inline" | "panel";
  disabled?: boolean;
  className?: string;
}

export function Disclosure({ summary, meta, children, open, defaultOpen, onOpenChange, variant = "inline", disabled, className }: DisclosureProps) {
  return (
    <Collapsible.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (o) => onOpenChange(o) : undefined}
      disabled={disabled}
      className={`${s.root} ${variant === "panel" ? s.panel : ""} ${className ?? ""}`}
    >
      <Collapsible.Trigger className={s.trigger}>
        <NavArrowRight className={s.chevron} strokeWidth={2} aria-hidden data-motion-gentle="" />
        <span className={s.summary}>{summary}</span>
        {meta !== undefined && <span className={s.meta}>{meta}</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel className={s.body} hiddenUntilFound data-motion-gentle="">
        <div className={s.content} data-motion-gentle="">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
