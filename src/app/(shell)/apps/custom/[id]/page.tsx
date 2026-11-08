import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { appDetail, currentTarget } from "@/server/appstore/service";
import { BuilderView, type BuilderTab } from "@/components/builder/BuilderView";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "App builder" };

const TABS: BuilderTab[] = ["details", "services", "compose", "files", "source", "history"];

export default async function CustomAppPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const at = Date.now();
  await requireAdmin();
  const [{ id }, sp, target] = await Promise.all([params, searchParams, currentTarget()]);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) notFound();
  const detail = await appDetail(id).catch(() => null);
  if (!detail) notFound();
  const tab = TABS.includes(sp.tab as BuilderTab) ? (sp.tab as BuilderTab) : "details";
  return <Seeded at={at}><BuilderView initial={detail} initialTab={tab === "source" && !detail.github ? "details" : tab} target={target} /></Seeded>;
}
