"use client";
import type { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

/**
 * Fetches a whole page ahead of a likely visit (what a Link with unstable_dynamicOnHover does on hover),
 * for navigations that don't come from a Link, like the palette. Only Gluon's own pages.
 */
export function prefetchPage(router: Router, href: string | undefined) {
  if (!href || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return;
  // PrefetchKind.FULL; the enum lives in a private Next module.
  router.prefetch(href, { kind: "full" } as unknown as Parameters<Router["prefetch"]>[1]);
}
