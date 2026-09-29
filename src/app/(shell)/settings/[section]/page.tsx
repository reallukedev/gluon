import { SECTIONS } from "@/components/settings/sections";
import { SettingsPage, type SettingsSearch } from "@/components/settings/SettingsPage";

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const s = SECTIONS.find((x) => x.id === section);
  return { title: s ? `${s.label} · Settings` : "Settings" };
}

export default async function Page({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<SettingsSearch> }) {
  const [{ section }, sp] = await Promise.all([params, searchParams]);
  return <SettingsPage section={section} searchParams={sp} />;
}
