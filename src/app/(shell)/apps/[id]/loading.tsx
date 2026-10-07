import { Page, Skeleton } from "@/components/ui/Surface";
import s from "@/components/apps/routeStates.module.css";

/** An app's page while it loads: icon and name, state, tabs, then its panels. */
export default function AppLoading() {
  return (
    <Page>
      <div role="status" aria-label="Loading the app">
        <Skeleton width={48} height={12} radius={3} />
        <div className={s.titleRow}>
          <Skeleton width={40} height={40} radius={10} />
          <Skeleton width={200} height={30} radius={6} />
        </div>
        <Skeleton width={150} height={14} radius={4} style={{ marginTop: 12 }} />
        <div className={s.tabs}>
          {[70, 40, 96, 60].map((w, i) => (
            <Skeleton key={i} width={w} height={12} radius={3} />
          ))}
        </div>
        <Skeleton height={260} radius={12} style={{ marginTop: 20 }} />
        <div className={s.grid}>
          <Skeleton height={180} radius={12} />
          <Skeleton height={180} radius={12} />
        </div>
      </div>
    </Page>
  );
}
