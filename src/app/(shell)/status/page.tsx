import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { statusFor } from "@/server/status";
import { getSetting } from "@/server/settings";
import { StatusView } from "@/components/status/StatusView";

export const metadata = { title: "Status" };

export default async function StatusPage() {
  const { user } = await requireUser();
  if (user.role !== "admin" && !getSetting("householdCanSeeStatus")) redirect("/");
  const initial = await statusFor(user);
  return <StatusView initial={initial} />;
}
