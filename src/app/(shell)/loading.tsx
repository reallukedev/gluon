import { Page, Skeleton } from "@/components/ui/Surface";

/** Shown while a page's server data loads, so navigating never leaves a blank screen. */
export default function Loading() {
  return (
    <Page>
      <div role="status" aria-label="Loading">
        <Skeleton width={220} height={36} radius={6} />
        <Skeleton width="min(520px, 80%)" height={16} radius={4} style={{ marginTop: 14 }} />
        <Skeleton height={240} radius={12} style={{ marginTop: 32 }} />
        <Skeleton height={160} radius={12} style={{ marginTop: 16 }} />
      </div>
    </Page>
  );
}
