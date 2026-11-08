import { notFound } from "next/navigation";
import { currentAuth, requireAdmin } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { siteDetail } from "@/server/sites/service";
import { SiteEditor } from "@/components/sites/SiteEditor";
import { Seeded } from "@/lib/client/seed";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  // Metadata can render before the page's own admin check.
  const auth = await currentAuth();
  if (auth?.user.role !== "admin") return { title: "Site" };
  const { id } = await params;
  try {
    return { title: siteDetail(id).name };
  } catch {
    return { title: "Site" };
  }
}

type Params = { id: string };
type Search = { file?: string };

export default async function SitePage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const at = Date.now();
  await requireAdmin();
  const [{ id }, { file }] = await Promise.all([params, searchParams]);
  let detail;
  try {
    detail = siteDetail(id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return <Seeded at={at}><SiteEditor initial={detail} openFile={typeof file === "string" && file.length <= 400 ? file : null} /></Seeded>;
}
