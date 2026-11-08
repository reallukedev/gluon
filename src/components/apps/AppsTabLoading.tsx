import { AppsHead, AppsBody } from "@/components/apps/AppsFrame";
import { AppsListBodySkeleton } from "@/components/apps/AppsListSkeleton";

/** A tab's data is on its way: the title and tabs stay, the summary and rows wait in their places. */
export default function AppsTabLoading() {
  return (
    <>
      <AppsHead />
      <AppsBody>
        <AppsListBodySkeleton />
      </AppsBody>
    </>
  );
}
