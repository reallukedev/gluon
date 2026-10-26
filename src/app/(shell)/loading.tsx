"use client";
import { usePathname } from "next/navigation";
import { Page, Skeleton } from "@/components/ui/Surface";
import { AppsListSkeleton } from "@/components/apps/AppsListSkeleton";

// The Apps tabs are routes of their own. Their skeleton lives here, at the section's door, rather
// than in apps/loading.tsx: a boundary inside /apps would blank the page header and tabs on every
// tab click, while this one only shows when you arrive at Apps from another page.
const APPS_LIST = /^\/apps(\/(store|custom|images|volumes|networks|disk))?\/?$/;

/** Shown while a page's server data loads, so navigating never leaves a blank screen. */
export default function Loading() {
  const pathname = usePathname();
  if (APPS_LIST.test(pathname)) return <AppsListSkeleton />;
  return (
    <Page pending>
      <div role="status" aria-label="Loading">
        <Skeleton width={220} height={36} radius={6} />
        <Skeleton width="min(520px, 80%)" height={16} radius={4} style={{ marginTop: 14 }} />
        <Skeleton height={240} radius={12} style={{ marginTop: 32 }} />
        <Skeleton height={160} radius={12} style={{ marginTop: 16 }} />
      </div>
    </Page>
  );
}
