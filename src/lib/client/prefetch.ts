"use client";
import * as React from "react";
import { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

const isPage = (href: string | undefined): href is string => !!href && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/");

/**
 * Fetches a whole page ahead of a likely visit, so the click lands on real content instead of a skeleton.
 * Once per intent: Link's own hover upgrade keeps refetching every hovered page in the background.
 */
export function prefetchPage(router: Router, href: string | undefined) {
  if (!isPage(href)) return;
  // PrefetchKind.FULL; the enum lives in a private Next module.
  router.prefetch(href, { kind: "full" } as unknown as Parameters<Router["prefetch"]>[1]);
}

// Long enough that sweeping the pointer across a list doesn't fetch every page it crosses.
const HOVER_INTENT_MS = 70;

export function useIntentPrefetch(href: string | undefined) {
  const router = useRouter();
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return React.useMemo(() => {
    if (!isPage(href)) return {};
    const now = () => {
      clearTimeout(timer.current);
      prefetchPage(router, href);
    };
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(now, HOVER_INTENT_MS);
    };
    const cancel = () => clearTimeout(timer.current);
    return {
      onPointerEnter: (e: React.PointerEvent) => (e.pointerType === "mouse" ? soon() : undefined),
      onPointerLeave: cancel,
      onPointerDown: now,
      onFocus: (e: React.FocusEvent) => (e.target.matches(":focus-visible") ? soon() : undefined),
      onBlur: cancel,
    };
  }, [href, router]);
}
