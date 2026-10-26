import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { siteDetail } from "@/server/sites/service";
import { SiteEditor } from "@/components/sites/SiteEditor";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
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
  await requireAdmin();
  const { id } = await params;
  const { file } = await searchParams;
  let detail;
  try {
    detail = siteDetail(id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return <SiteEditor initial={detail} openFile={typeof file === "string" && file.length <= 400 ? file : null} />;
}
