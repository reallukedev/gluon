import { Page } from "@/components/ui/Surface";
import { AppsFrame } from "@/components/apps/AppsFrame";

/**
 * The Apps tabs (All apps, App store, Custom, Docker) are routes of their own. Their title and tabs live
 * here so they stay put while the tab below changes; each tab still writes its own summary and actions.
 * An app's page and a container's page sit outside this group and keep their own header.
 */
export default function AppsSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <AppsFrame>{children}</AppsFrame>
    </Page>
  );
}
