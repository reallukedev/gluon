import { AppsHead, AppsBody } from "@/components/apps/AppsFrame";
import { AppsListBodySkeleton } from "@/components/apps/AppsListSkeleton";

export function AppsTabLoading() {
  return (
    <>
      <AppsHead />
      <AppsBody>
        <AppsListBodySkeleton />
      </AppsBody>
    </>
  );
}
