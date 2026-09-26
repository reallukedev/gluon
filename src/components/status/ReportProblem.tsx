"use client";
import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, TextArea } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/Toast";
import { mutate } from "swr";
import { api, ApiError } from "@/lib/client/api";
import { MY_REPORTS_URL } from "@/components/people/MyReports";

/** Household members tell the admin something's wrong, in their own words. */
export function ReportProblem({ apps, appId, trigger }: { apps: { id: string; name: string }[]; appId?: string; trigger?: React.ReactElement }) {
  const [open, setOpen] = React.useState(false);
  const [app, setApp] = React.useState(appId ?? "");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    if (message.trim().length < 3) {
      setError("Say a few words about what's happening.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/household/reports", { appId: app || null, message: message.trim() });
      void mutate(MY_REPORTS_URL);
      toast.success("Sent. You'll see a reply here when someone looks at it.");
      setOpen(false);
      setMessage("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const options = [{ value: "", label: "Not sure / something else" }, ...apps.map((a) => ({ value: a.id, label: a.name }))];
  return (
    <>
      {trigger ? React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, { onClick: () => setOpen(true) }) : <Button onClick={() => setOpen(true)}>Something's not working</Button>}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="What's not working?"
        description="Whoever looks after the server gets a message straight away."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void send()} loading={busy}>
              Send
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 16 }}>
          <Field label="Which app?">
            <Select value={app} onChange={setApp} options={options} aria-label="Which app" />
          </Field>
          <Field label="What happened?" error={error}>
            <TextArea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Jellyfin says it can't play this episode" rows={4} maxLength={1000} autoFocus />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
