import { requireAdmin } from "@/server/auth/session";
import { currentTarget } from "@/server/appstore/service";
import { NewAppView } from "@/components/builder/NewAppView";

export const metadata = { title: "Make an app" };

export default async function NewAppPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  await requireAdmin();
  const [sp, target] = await Promise.all([searchParams, currentTarget()]);
  const from = sp.from === "image" || sp.from === "compose" || sp.from === "github" ? sp.from : null;
  return <NewAppView initial={from} target={target} />;
}
