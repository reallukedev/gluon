"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { checkSitePath } from "@/lib/sites-types";

/** Ask for one name (a new file, a folder, a rename). The server's answer shows under the field. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  initial,
  confirmLabel,
  prefix,
  selectStem,
  validate,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  label: string;
  initial: string;
  confirmLabel: string;
  /** The folder it goes in, shown before the field. */
  prefix?: string;
  /** Select the name without its extension, ready to type over. */
  selectStem?: boolean;
  validate?: (name: string) => string | null;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const dot = selectStem ? value.lastIndexOf(".") : -1;
      el.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
    return () => cancelAnimationFrame(t);
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    const name = value.trim();
    const local = name.includes("/") ? "A name can't have a / in it. Use Move to put it in another folder." : (validate?.(name) ?? (checkSitePath(prefix ? `${prefix}/${name}` : name).ok ? null : (checkSitePath(prefix ? `${prefix}/${name}` : name) as { message: string }).message));
    if (local) {
      setError(local);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(name);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {confirmLabel}
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
        <Field label={label} error={error} description={prefix ? `In ${prefix}/` : undefined}>
          <Input ref={ref} value={value} onChange={(e) => (setValue(e.target.value), setError(null))} mono spellCheck={false} autoCapitalize="off" autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}

// Select values can't be empty; no real folder is called ".".
const TOP = ".";

/** Pick the folder something moves to. */
export function MoveDialog({ open, onOpenChange, path, dirs, isDir, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; path: string; dirs: string[]; isDir: boolean; onSubmit: (to: string) => Promise<void> }) {
  const name = path.split("/").pop()!;
  const from = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const choices = ["", ...dirs].filter((d) => !(isDir && (d === path || d.startsWith(`${path}/`))));
  const [to, setTo] = React.useState(from);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    setBusy(true);
    try {
      await onSubmit(to ? `${to}/${name}` : name);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "It didn't move.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={`Move ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={to === from}>
            Move
          </Button>
        </>
      }
    >
      <Field label="Folder" error={error}>
        <Select value={to || TOP} onChange={(v) => (setTo(v === TOP ? "" : v), setError(null))} options={choices.map((d) => ({ value: d || TOP, label: d ? `${d}/` : "Top of the site" }))} aria-label="Folder" />
      </Field>
    </Dialog>
  );
}
