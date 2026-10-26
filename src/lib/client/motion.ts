"use client";
import * as React from "react";

/**
 * Reduced motion, as the person sees it: their own setting (html[data-motion="reduce"]) or the
 * system's. CSS should prefer the `--motion` token (1 or 0); use this only where JS drives motion.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function read(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.motion === "reduce" || window.matchMedia(QUERY).matches;
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => {
    mq.removeEventListener("change", cb);
    mo.disconnect();
  };
}

export function prefersReducedMotion(): boolean {
  return read();
}

export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, read, () => false);
}

/** True while the viewport matches `query`; false during SSR and the first client render. */
export function useMediaQuery(query: string): boolean {
  const sub = React.useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  return React.useSyncExternalStore(sub, () => window.matchMedia(query).matches, () => false);
}
