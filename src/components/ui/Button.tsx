"use client";
import * as React from "react";
import Link from "next/link";
import { Button as BaseButton } from "@base-ui/react/button";
import { Tooltip } from "./Tooltip";
import s from "./button.module.css";

export type ButtonVariant = "secondary" | "primary" | "attention" | "ghost" | "danger" | "dangerSolid";
export type ButtonSize = "sm" | "md" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconEnd?: React.ReactNode;
  className?: string;
}

export function buttonClass({ variant = "secondary", size = "md", block, icon }: Pick<Common, "variant" | "size" | "block"> & { icon?: boolean }) {
  return [s.button, variant !== "secondary" && s[variant], size !== "md" && s[size], block && s.block, icon && s.icon].filter(Boolean).join(" ");
}

type ButtonProps = Common & Omit<React.ComponentPropsWithoutRef<"button">, "className">;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, block, loading, icon, iconEnd, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      data-loading={loading ? "" : undefined}
      data-motion-gentle=""
      aria-busy={loading || undefined}
      className={[buttonClass({ variant, size, block }), className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon}
      {children !== undefined && <span className={s.label}>{children}</span>}
      {iconEnd}
    </BaseButton>
  );
});

type LinkButtonProps = Common & Omit<React.ComponentPropsWithoutRef<typeof Link>, "className">;

export function LinkButton({ variant, size, block, icon, iconEnd, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={[buttonClass({ variant, size, block }), className].filter(Boolean).join(" ")} data-motion-gentle="" {...rest}>
      {icon}
      {children !== undefined && <span className={s.label}>{children}</span>}
      {iconEnd}
    </Link>
  );
}

type IconButtonProps = Omit<ButtonProps, "children" | "icon" | "iconEnd"> & {
  label: string;
  children: React.ReactNode;
  /** Show the label as a tooltip on hover (default true). */
  tooltip?: boolean;
  shortcut?: string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = "ghost", size, tooltip = true, shortcut, className, disabled, loading, type = "button", ...rest },
  ref,
) {
  const btn = (
    <BaseButton
      ref={ref}
      type={type}
      aria-label={label}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      data-loading={loading ? "" : undefined}
      data-motion-gentle=""
      aria-busy={loading || undefined}
      className={[buttonClass({ variant, size, icon: true }), className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </BaseButton>
  );
  if (!tooltip) return btn;
  return <Tooltip content={label} shortcut={shortcut}>{btn}</Tooltip>;
});
