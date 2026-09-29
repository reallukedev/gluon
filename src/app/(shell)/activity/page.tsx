import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { activityHref } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Activity is in Settings now. Old links keep their person and target filters. */
export default async function ActivityRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  // Only admins keep watch; anyone else lands on their start page instead of a "not found".
  if (user.role !== "admin") redirect("/");
  const sp = await searchParams;
  redirect(activityHref({ target: str(sp.target, 500), user: str(sp.user, 64) }));
}
