"use client";
import { Page, PageHeader, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";

/** Apps (or one app's page) failed to load: say what happened and offer to try again. */
export default function AppsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <PageHeader title="Apps didn't load" summary="Gluon couldn't read the apps on this server just now. Nothing was changed." />
      <Notice
        tone="fault"
        title="Couldn't load your apps"
        action={
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
        }
      >
        Docker may be restarting or busy. Try again in a moment.{error.digest ? ` If it keeps happening, the server log has the details (reference ${error.digest}).` : ""}
      </Notice>
    </Page>
  );
}
