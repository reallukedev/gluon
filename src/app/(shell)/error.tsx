"use client";
import { Page, PageHeader, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";

/** A page that failed to load: say so in Gluon's own words and offer to try again. */
export default function ShellError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <PageHeader title="This page didn't load" summary="Gluon hit a problem getting it ready. Nothing on the server was changed." />
      <Notice
        tone="fault"
        title="Couldn't load this page"
        action={
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
        }
      >
        {error.digest ? `If it keeps happening, the server log has the details (reference ${error.digest}).` : "If it keeps happening, the server log has the details."}
      </Notice>
    </Page>
  );
}
