import { requireAdmin } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { appDetail, currentTarget } from "@/server/appstore/service";
import { NewAppView } from "@/components/builder/NewAppView";
import type { DraftStep } from "@/components/builder/flow/DraftFlow";
import type { FlowSource } from "@/components/builder/flow/SourceStep";
import type { CustomAppDetail } from "@/lib/builder-types";

export const metadata = { title: "Make an app" };

const SOURCES: FlowSource[] = ["image", "run", "compose", "github"];
const STEPS: DraftStep[] = ["setup", "address", "review", "start"];

export default async function NewAppPage({ searchParams }: { searchParams: Promise<{ from?: string; draft?: string; step?: string }> }) {
  await requireAdmin();
  const [sp, target] = await Promise.all([searchParams, currentTarget()]);
  const source = SOURCES.includes(sp.from as FlowSource) ? (sp.from as FlowSource) : "image";
  const step = STEPS.includes(sp.step as DraftStep) ? (sp.step as DraftStep) : "setup";
  const id = sp.draft && /^[A-Za-z0-9_-]{6,20}$/.test(sp.draft) ? sp.draft : null;
  let draft: CustomAppDetail | null = null;
  let missing = false;
  let loadError: string | null = null;
  if (id) {
    try {
      draft = await appDetail(id);
    } catch (e) {
      // Only "not found" means it's gone; anything else (a busy database, Umbrel slow) is worth a retry.
      if (e instanceof AppError && e.code === "not_found") missing = true;
      else loadError = e instanceof Error ? e.message : "The draft didn't load.";
    }
  }
  return <NewAppView initialSource={source} initialDraft={draft} initialStep={step} missingDraft={missing} draftError={loadError} target={target} />;
}
