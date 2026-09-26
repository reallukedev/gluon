"use client";
import * as React from "react";
import Link from "next/link";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import s from "./tabs.module.css";

export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  count?: number;
  attention?: boolean;
}

interface Props<T extends string> {
  value: T;
  onChange?: (v: T) => void;
  items: readonly TabItem<T>[];
  /** When set, tabs are links (route-driven tabs). */
  hrefFor?: (v: T) => string;
  children?: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * Underlined tabs. The 2px indicator glides between tabs (200ms, --ease-in-out: a moving element)
 * so the eye follows the change; keyboard changes and the first paint land instantly. On narrow
 * screens the list scrolls sideways and keeps the active tab in view.
 */
export function Tabs<T extends string>({ value, onChange, items, hrefFor, children, className, ...aria }: Props<T>) {
  const list = React.useRef<HTMLDivElement>(null);
  const [ready, setReady] = React.useState(false);
  const [keyboard, setKeyboard] = React.useState(false);

  React.useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Keep the active tab visible when the list scrolls sideways (phones).
  React.useEffect(() => {
    const l = list.current;
    const tab = l?.querySelector<HTMLElement>("[data-active]");
    if (!l || !tab || l.scrollWidth <= l.clientWidth) return;
    const left = tab.offsetLeft - 16;
    const right = tab.offsetLeft + tab.offsetWidth + 16;
    if (left < l.scrollLeft) l.scrollTo({ left, behavior: ready ? "smooth" : "auto" });
    else if (right > l.scrollLeft + l.clientWidth) l.scrollTo({ left: right - l.clientWidth, behavior: ready ? "smooth" : "auto" });
  }, [value, ready]);

  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onChange?.(v as T)} className={className}>
      <BaseTabs.List
        ref={list}
        className={s.list}
        aria-label={aria["aria-label"]}
        data-ready={ready ? "" : undefined}
        data-keyboard={keyboard ? "" : undefined}
        onPointerDown={() => setKeyboard(false)}
        onKeyDown={() => setKeyboard(true)}
      >
        {items.map((it) => (
          <BaseTabs.Tab
            key={it.value}
            value={it.value}
            className={s.tab}
            render={hrefFor ? <Link href={hrefFor(it.value)} scroll={false} /> : undefined}
            nativeButton={!hrefFor}
          >
            {it.label}
            {it.count !== undefined && (
              <span className={`${s.count} ${it.attention ? s.countAttn : ""}`}>{it.count}</span>
            )}
          </BaseTabs.Tab>
        ))}
        <BaseTabs.Indicator className={s.indicator} renderBeforeHydration />
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  return (
    <BaseTabs.Panel value={value} className={className}>
      {children}
    </BaseTabs.Panel>
  );
}
