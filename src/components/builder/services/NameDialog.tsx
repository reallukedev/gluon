"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { serviceNameError } from "@/lib/builder/names";

/** Name a new service, or rename one. */
export function NameDialog({ open, onOpenChange, title, confirm, taken, initial, description, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; confirm: string; taken: string[]; initial: string; description?: string; onDone: (name: string) => void | Promise<void> }) {
  const [name, setName] = React.useState(initial);
  React.useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const err = name ? serviceNameError(name) ?? (taken.includes(name) ? "Another service already has that name." : null) : null;
  const submit = async () => {
    if (!name || err) return;
    await onDone(name);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name || !!err} onClick={() => void submit()}>
            {confirm}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Service name" description="Lowercase letters, digits, - and _." error={err}>
          <Input value={name} mono autoFocus onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={40} spellCheck={false} autoCapitalize="off" />
        </Field>
      </form>
    </Dialog>
  );
}
