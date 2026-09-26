import { requireAdmin } from "@/server/auth/session";
import { listPeople } from "@/server/people/users";
import { PeopleView, type PeopleTab } from "@/components/people/PeopleView";
import { PersonDetail } from "@/components/people/PersonDetail";

export const metadata = { title: "People" };

const TABS: PeopleTab[] = ["people", "access", "reports", "announcements"];

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ tab?: string; person?: string; report?: string }> }) {
  const { user } = await requireAdmin();
  const sp = await searchParams;
  const people = listPeople(user);
  if (sp.person) {
    const person = people.find((p) => p.id === sp.person);
    if (person) return <PersonDetail initial={person} />;
  }
  const tab = TABS.includes(sp.tab as PeopleTab) ? (sp.tab as PeopleTab) : "people";
  return <PeopleView tab={tab} initialPeople={people} reportId={sp.report ?? null} />;
}
