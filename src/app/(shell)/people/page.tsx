import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { PEOPLE_TABS, peopleHref, type PeopleTab } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Old People links, which now live in Settings. */
export default async function PeopleRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  // Members go to their start page rather than a "not found".
  if (user.role !== "admin") redirect("/");
  const sp = await searchParams;
  const tab = str(sp.tab, 40);
  redirect(
    peopleHref({
      tab: PEOPLE_TABS.includes(tab as PeopleTab) ? (tab as PeopleTab) : null,
      person: str(sp.person, 64),
      report: str(sp.report, 64),
    }),
  );
}
