import { notFound } from "next/navigation";
import { currentAuth, requireAdmin } from "@/server/auth/session";
import { appDetail } from "@/server/docker/detail";
import { getApp } from "@/server/docker/apps";
import { listUsers } from "@/server/auth/users";
import { AppDetailView } from "@/components/apps/AppDetailView";
import { Seeded } from "@/lib/client/seed";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  // Metadata can render before the page's own admin check.
  const auth = await currentAuth();
  if (auth?.user.role !== "admin") return { title: "App" };
  const id = decodeURIComponent((await params).id);
  const app = await getApp(id).catch(() => null);
  return { title: app?.name ?? id };
}

export default async function AppPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; container?: string }> }) {
  const at = Date.now();
  await requireAdmin();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const detail = await appDetail(decodeURIComponent(id)).catch(() => null);
  if (!detail) notFound();
  const members = listUsers().filter((u) => u.role === "member").map((u) => ({ id: u.id, name: u.displayName }));
  const tab = sp.tab === "logs" || sp.tab === "compose" || sp.tab === "settings" || sp.tab === "chat" || sp.tab === "voice" ? sp.tab : "overview";
  return <Seeded at={at}><AppDetailView initial={detail} tab={tab} container={sp.container ?? null} members={members} /></Seeded>;
}
