"use client";
/**
 * CopyButton — copies a value and says so in place, no toast needed.
 *
 *   <CopyButton value={url} label="Copy address" />            // icon only, with tooltip
 *   <CopyButton value={command} size="sm">Copy command</CopyButton>  // with text
 *
 * - The copy glyph gives way to a tick that draws itself (stroke over 250ms on --ease-out), then
 *   settles back after 1.6s. Text buttons swap "Copy…" for "Copied" in a fixed-width slot, so the
 *   button never changes size. Reduced motion: the tick appears without drawing.
 * - Works over plain http on the LAN (falls back when the Clipboard API is unavailable).
 * - Announces "Copied" to screen readers; a failed copy shows an error toast with the value.
 */
import * as React from "react";
import { Copy } from "iconoir-react";
import { copyText } from "@/lib/client/clipboard";
import { Button, IconButton, type ButtonSize, type ButtonVariant } from "./Button";
import { toast } from "./Toast";
import s from "./copy.module.css";

interface CopyButtonProps {
  value: string;
  /** Accessible name (and tooltip) for the icon-only form. */
  label?: string;
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  onCopied?: () => void;
}

function Glyph({ copied }: { copied: boolean }) {
  return (
    <span className={s.glyph} data-copied={copied ? "" : undefined} aria-hidden>
      <Copy className={s.copy} data-motion-gentle="" />
      <svg className={s.tick} viewBox="0 0 24 24" fill="none" data-motion-gentle="">
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" data-motion-gentle="" />
      </svg>
    </span>
  );
}

export function CopyButton({ value, label = "Copy", children, variant, size = "sm", className, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(value);
    if (!ok) {
      toast.error("Couldn't copy", { description: value.length > 120 ? `${value.slice(0, 120)}…` : value });
      return;
    }
    setCopied(true);
    onCopied?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  const live = (
    <span className="sr-only" role="status" aria-live="polite">
      {copied ? "Copied" : ""}
    </span>
  );

  if (children === undefined) {
    return (
      <>
        <IconButton label={label} size={size} variant={variant ?? "ghost"} className={className} onClick={() => void onClick()}>
          <Glyph copied={copied} />
        </IconButton>
        {live}
      </>
    );
  }
  return (
    <>
      <Button variant={variant} size={size} className={className} icon={<Glyph copied={copied} />} onClick={() => void onClick()}>
        <span className={s.slot}>
          <span data-shown={!copied ? "" : undefined}>{children}</span>
          <span data-shown={copied ? "" : undefined} aria-hidden={!copied}>
            Copied
          </span>
        </span>
      </Button>
      {live}
    </>
  );
}
