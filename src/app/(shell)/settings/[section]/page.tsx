import { SECTIONS } from "@/components/settings/sections";
import { SettingsPage } from "@/components/settings/SettingsPage";

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const s = SECTIONS.find((x) => x.id === section);
  return { title: s ? `${s.label} · Settings` : "Settings" };
}

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  return <SettingsPage section={(await params).section} />;
}
