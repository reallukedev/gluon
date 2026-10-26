import { requireUser } from "@/server/auth/session";
import { SECTIONS } from "@/components/settings/sections";
import { SettingsFrame } from "@/components/settings/SettingsFrame";

// The section list lives here, not in each section's page, so it stays mounted (and keeps focus) as you move between sections.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  const sections = SECTIONS.filter((s) => !s.admin || user.role === "admin");
  return <SettingsFrame sections={sections}>{children}</SettingsFrame>;
}
