"use client";
import { Page, PageHeader, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";

/** Apps (or one app's page) failed to load: say what happened and offer to try again. */
export default function AppsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <PageHeader title="Apps" summary="Couldn't read the apps on this server. Nothing was changed." />
      <Notice
        tone="fault"
        action={
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
        }
      >
        Docker may be restarting. Try again in a moment.{error.digest ? ` If it keeps failing, the server log has the details (${error.digest}).` : ""}
      </Notice>
    </Page>
  );
}
