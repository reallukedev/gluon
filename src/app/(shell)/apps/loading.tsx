import { Page, Skeleton } from "@/components/ui/Surface";
import s from "@/components/apps/routeStates.module.css";

/** The Apps page while its list loads: title, summary, tabs, toolbar and rows in their places. */
export default function AppsLoading() {
  return (
    <Page>
      <div role="status" aria-label="Loading apps">
        <Skeleton width={120} height={34} radius={6} />
        <Skeleton width="min(460px, 80%)" height={15} radius={4} style={{ marginTop: 14 }} />
        <div className={s.tabs}>
          {[64, 72, 92, 70].map((w, i) => (
            <Skeleton key={i} width={w} height={12} radius={3} />
          ))}
        </div>
        <div className={s.toolbar}>
          <Skeleton width="min(380px, 100%)" height={34} radius={8} />
          <Skeleton width={260} height={34} radius={9} />
        </div>
        <div className={s.table}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className={s.row}>
              <Skeleton width={34} height={34} radius={8} />
              <span className={s.name}>
                <Skeleton width={`${46 + ((i * 37) % 30)}%`} height={13} />
                <Skeleton width={`${24 + ((i * 23) % 18)}%`} height={10} />
              </span>
              <Skeleton width={`${50 + ((i * 29) % 30)}%`} height={12} />
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
