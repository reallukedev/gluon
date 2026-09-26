"use client";
/**
 * HoldButton — press and hold to confirm the most dangerous actions (power off, wipe a disk).
 *
 *   <HoldButton holdMs={1500} onConfirm={shutDown}>Hold to shut down</HoldButton>
 *
 * - A darkening sweep fills the button left to right while held (clip-path, linear: it is a
 *   progress indicator), and snaps back in 200ms if released early.
 * - Works with a mouse, a finger (no long-press callout), and the keyboard (hold Enter or Space).
 * - Assistive tech that can only "click" confirms on activation: that click is deliberate.
 * - `onConfirm` may return a promise; the button shows its loading state until it settles.
 *   Pass `loading` to control that yourself.
 * - Reduced motion keeps the sweep (it is progress, not travel).
 */
import * as React from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import s from "./hold.module.css";

export interface HoldButtonProps {
  onConfirm: () => unknown;
  children: React.ReactNode;
  holdMs?: number;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  className?: string;
  /** Read to screen readers after the label. */
  hint?: string;
}

export function HoldButton({
  onConfirm,
  children,
  holdMs = 1500,
  variant = "dangerSolid",
  size,
  block,
  disabled,
  loading,
  icon,
  className,
  hint = "Press and hold to confirm.",
}: HoldButtonProps) {
  const [holding, setHolding] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = React.useRef(false);
  const hintId = React.useId();
  const isBusy = loading ?? busy;

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const fire = React.useCallback(async () => {
    active.current = false;
    setHolding(false);
    setDone(true);
    try {
      navigator.vibrate?.(12);
    } catch {
      /* not supported */
    }
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setDone(false);
    }
  }, [onConfirm]);

  const start = () => {
    if (disabled || isBusy || active.current) return;
    active.current = true;
    setHolding(true);
    timer.current = setTimeout(() => void fire(), holdMs);
  };
  const end = () => {
    if (!active.current) return;
    active.current = false;
    clearTimeout(timer.current);
    setHolding(false);
  };

  return (
    <Button
      variant={variant}
      size={size}
      block={block}
      icon={icon}
      disabled={disabled}
      loading={isBusy}
      className={`${s.hold} ${className ?? ""}`}
      data-holding={holding ? "" : undefined}
      data-done={done ? "" : undefined}
      aria-describedby={hintId}
      style={
        {
          "--hold-ms": `${holdMs}ms`,
          // Solid buttons darken; outlined ones fill with ink.
          "--hold-fill": variant === "dangerSolid" || variant === "primary" || variant === "attention" ? "color-mix(in oklab, #000 22%, transparent)" : "color-mix(in oklab, var(--ink) 12%, transparent)",
        } as React.CSSProperties
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start();
      }}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // no native click: the hold decides
          if (!e.repeat) start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          end();
        }
      }}
      onBlur={end}
      onClick={(e) => {
        // Pointer and keyboard presses are handled by the hold. A click with no press behind it
        // comes from assistive tech (VoiceOver, Switch Control): honour it.
        if (e.detail === 0 && !active.current && !holding && !disabled && !isBusy) void fire();
      }}
    >
      <span className={s.fill} aria-hidden data-motion-gentle="" />
      <span className={s.text}>{children}</span>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </Button>
  );
}
