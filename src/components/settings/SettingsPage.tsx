import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { listActivity } from "@/server/audit";
import { listUsers } from "@/server/auth/users";
import { listPeople } from "@/server/people/users";
import { ALERTS_TABS, PEOPLE_TABS, peopleHref, type AlertsTab, type PeopleTab } from "@/lib/settings-links";
import { AlertsSettings } from "@/components/alerts/AlertsSettings";
import { ActivityView } from "@/components/activity/ActivityView";
import { PeopleSettings } from "@/components/people/PeopleView";
import { SECTIONS } from "./sections";
import { SettingsView } from "./SettingsView";
import { Appearance, Formats, HomePrefs } from "./personal";
import { Navigation } from "./Navigation";
import { Notifications } from "./Notifications";
import { Security } from "./Security";
import { Server } from "./Server";
import { Integrations } from "./Integrations";
import { Updates } from "./Updates";
import { About } from "./About";

export type SettingsSearch = Record<string, string | string[] | undefined>;

// Imported here rather than lazily in the client: the one shown is then loaded with the page and hydrates with it,
// so a click right after the page appears is never dropped. Each is still its own chunk.
const CONTENT: Record<string, React.ComponentType> = {
  appearance: Appearance,
  home: HomePrefs,
  navigation: Navigation,
  formats: Formats,
  security: Security,
  server: Server,
  updates: Updates,
  about: About,
  notifications: Notifications,
  integrations: Integrations,
};

const ACTIVITY_PAGE = 60;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

export async function SettingsPage({ section, searchParams = {} }: { section: string | null; searchParams?: SettingsSearch }) {
  const { user } = await requireUser();
  // Household defaults is part of People now (its "New members" tab).
  if (section === "household") redirect(user.role === "admin" ? peopleHref({ tab: "defaults" }) : "/settings");
  const available = SECTIONS.filter((s) => !s.admin || user.role === "admin");
  if (section && !available.some((s) => s.id === section)) notFound();

  // The Keep watch sections start with what they show, so the first paint isn't a skeleton.
  let content: React.ReactNode;
  if (section === "alerts") {
    const tab = str(searchParams.tab, 40);
    const t = ALERTS_TABS.includes(tab as AlertsTab) ? (tab as AlertsTab) : "watching";
    content = <AlertsSettings key={t} tab={t} monitorId={str(searchParams.monitor, 200) ?? null} channelId={str(searchParams.channel, 200) ?? null} />;
  } else if (section === "activity") {
    const target = str(searchParams.target, 500);
    const userId = str(searchParams.user, 64);
    const items = listActivity({ limit: ACTIVITY_PAGE + 1, target, userId });
    content = (
      <ActivityView
        key={`${target ?? ""}|${userId ?? ""}`}
        initial={{ items: items.slice(0, ACTIVITY_PAGE), next: items.length > ACTIVITY_PAGE ? items[ACTIVITY_PAGE - 1]!.id : null }}
        people={listUsers().map((u) => ({ id: u.id, name: u.displayName, username: u.username }))}
        initialTarget={target ?? ""}
        initialUser={userId ?? ""}
        pageSize={ACTIVITY_PAGE}
      />
    );
  } else if (section === "people") {
    const people = listPeople(user);
    const personId = str(searchParams.person, 64);
    const tab = str(searchParams.tab, 40);
    const t = PEOPLE_TABS.includes(tab as PeopleTab) ? (tab as PeopleTab) : "people";
    const person = personId ? (people.find((p) => p.id === personId) ?? null) : null;
    content = <PeopleSettings key={person?.id ?? t} tab={t} initialPeople={people} person={person} reportId={str(searchParams.report, 64) ?? null} />;
  } else {
    const C = CONTENT[section ?? "appearance"];
    content = C ? <C /> : null;
  }
  return <SettingsView section={section}>{content}</SettingsView>;
}
