"use client";
/**
 * Height is the one layout property animated here: an accordion has no transform equivalent. Closed contents stay
 * findable with find-in-page (`hidden="until-found"`).
 */
import * as React from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { NavArrowRight } from "iconoir-react";
import s from "./disclosure.module.css";

interface DisclosureProps {
  summary: React.ReactNode;
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
