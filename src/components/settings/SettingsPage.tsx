import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { listActivity } from "@/server/audit";
import { listUsers } from "@/server/auth/users";
import { listPeople } from "@/server/people/users";
import { ALERTS_TABS, PEOPLE_TABS, peopleHref, type AlertsTab, type PeopleTab } from "@/lib/settings-links";
import { SECTIONS } from "./sections";
import { SettingsView, type SectionData } from "./SettingsView";

export type SettingsSearch = Record<string, string | string[] | undefined>;

const ACTIVITY_PAGE = 60;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

export async function SettingsPage({ section, searchParams = {} }: { section: string | null; searchParams?: SettingsSearch }) {
  const { user } = await requireUser();
  // Household defaults is part of People now (its "New members" tab).
  if (section === "household") redirect(user.role === "admin" ? peopleHref({ tab: "defaults" }) : "/settings");
  const available = SECTIONS.filter((s) => !s.admin || user.role === "admin");
  if (section && !available.some((s) => s.id === section)) notFound();

  // The Keep watch sections start with what they show, so the first paint isn't a skeleton.
  let data: SectionData = null;
  if (section === "alerts") {
    const tab = str(searchParams.tab, 40);
    data = {
      kind: "alerts",
      tab: ALERTS_TABS.includes(tab as AlertsTab) ? (tab as AlertsTab) : "watching",
      monitorId: str(searchParams.monitor, 200) ?? null,
      channelId: str(searchParams.channel, 200) ?? null,
    };
  } else if (section === "activity") {
    const target = str(searchParams.target, 500);
    const userId = str(searchParams.user, 64);
    const items = listActivity({ limit: ACTIVITY_PAGE + 1, target, userId });
    data = {
      kind: "activity",
      initial: { items: items.slice(0, ACTIVITY_PAGE), next: items.length > ACTIVITY_PAGE ? items[ACTIVITY_PAGE - 1]!.id : null },
      people: listUsers().map((u) => ({ id: u.id, name: u.displayName, username: u.username })),
      initialTarget: target ?? "",
      initialUser: userId ?? "",
      pageSize: ACTIVITY_PAGE,
    };
  } else if (section === "people") {
    const people = listPeople(user);
    const personId = str(searchParams.person, 64);
    const tab = str(searchParams.tab, 40);
    data = {
      kind: "people",
      tab: PEOPLE_TABS.includes(tab as PeopleTab) ? (tab as PeopleTab) : "people",
      initialPeople: people,
      person: personId ? (people.find((p) => p.id === personId) ?? null) : null,
      reportId: str(searchParams.report, 64) ?? null,
    };
  }
  return <SettingsView sections={available} section={section} data={data} />;
}
