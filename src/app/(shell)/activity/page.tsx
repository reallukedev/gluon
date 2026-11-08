import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { activityHref } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Old Activity links, which now live in Settings. */
export default async function ActivityRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  // Members go to their start page rather than a "not found".
  if (user.role !== "admin") redirect("/");
  const sp = await searchParams;
  redirect(activityHref({ target: str(sp.target, 500), user: str(sp.user, 64) }));
}
