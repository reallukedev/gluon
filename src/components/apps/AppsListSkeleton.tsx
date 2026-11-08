import { Skeleton } from "@/components/ui/Surface";
import s from "@/components/apps/routeStates.module.css";

/** Just the toolbar and rows, for a tab change inside Apps (the title and tabs are already there). */
export function AppsListBodySkeleton() {
  return (
    <div role="status" aria-label="Loading" className={s.bodyOnly} data-pending="">
      <Rows />
    </div>
  );
}

function Rows() {
  return (
    <>
      <div className={s.toolbar}>
        <Skeleton width="min(380px, 100%)" height={34} radius={8} />
        <Skeleton width={260} height={34} radius={9} />
      </div>
      <div className={s.table}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className={s.row}>
            <Skeleton width={40} height={40} radius={10} />
            <span className={s.name}>
              <Skeleton width={`${46 + ((i * 37) % 30)}%`} height={13} />
              <Skeleton width={`${24 + ((i * 23) % 18)}%`} height={10} />
            </span>
            <Skeleton width={`${50 + ((i * 29) % 30)}%`} height={12} />
          </div>
        ))}
      </div>
    </>
  );
}
