import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { SECTIONS } from "./sections";
import { SettingsView } from "./SettingsView";

export async function SettingsPage({ section }: { section: string | null }) {
  const { user } = await requireUser();
  const available = SECTIONS.filter((s) => !s.admin || user.role === "admin");
  if (section && !available.some((s) => s.id === section)) notFound();
  return <SettingsView sections={available} section={section} />;
}
