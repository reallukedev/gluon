import { activePlatform } from "@/server/platform";
import { AppsPlatform } from "@/components/docker/AppsSectionTabs";

/** Tells the Apps tabs which platform is active (the App store tab needs Umbrel). */
export default async function AppsLayout({ children }: { children: React.ReactNode }) {
  const platform = await activePlatform().catch(() => "none" as const);
  return <AppsPlatform value={platform}>{children}</AppsPlatform>;
}
