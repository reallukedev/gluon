import { Page } from "@/components/ui/Surface";
import { AppsFrame } from "@/components/apps/AppsFrame";

/** The Apps title and tabs live here so they stay put while the tab below changes. */
export default function AppsSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <AppsFrame>{children}</AppsFrame>
    </Page>
  );
}
