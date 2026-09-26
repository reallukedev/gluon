import { requireAdmin } from "@/server/auth/session";
import { listActivity } from "@/server/audit";
import { listUsers } from "@/server/auth/users";
import { ActivityView } from "@/components/activity/ActivityView";

export const metadata = { title: "Activity" };

const PAGE = 60;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ target?: string; user?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const target = sp.target?.slice(0, 500) || undefined;
  const userId = sp.user?.slice(0, 64) || undefined;
  const items = listActivity({ limit: PAGE + 1, target, userId });
  const people = listUsers().map((u) => ({ id: u.id, name: u.displayName, username: u.username }));
  return (
    <ActivityView
      initial={{ items: items.slice(0, PAGE), next: items.length > PAGE ? items[PAGE - 1]!.id : null }}
      people={people}
      initialTarget={target ?? ""}
      initialUser={userId ?? ""}
      pageSize={PAGE}
    />
  );
}
