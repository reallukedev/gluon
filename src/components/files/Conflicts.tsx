"use client";
import * as React from "react";
import type { ConflictPolicy, FileEntry } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { KindIcon } from "./lib";
import s from "./files.module.css";

export interface ConflictItem {
  name: string;
  isDir: boolean;
  existing: FileEntry | null;
  /** Incoming size, when known (uploads). */
  size?: number | null;
}

type Verb = "move" | "copy" | "upload" | "restore";

interface Pending {
  items: ConflictItem[];
  dest: string;
  verb: Verb;
  resolve: (r: Map<string, ConflictPolicy> | null) => void;
}

/**
 * Ask what to do about names that already exist, one at a time, with "do the same for the rest".
 * Resolves to name → policy, or null when the person cancels the whole operation.
 */
export function useConflicts() {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [index, setIndex] = React.useState(0);
  const [all, setAll] = React.useState(false);
  const answers = React.useRef(new Map<string, ConflictPolicy>());

  const ask = React.useCallback(
    (items: ConflictItem[], dest: string, verb: Verb) =>
      new Promise<Map<string, ConflictPolicy> | null>((resolve) => {
        if (!items.length) return resolve(new Map());
        answers.current = new Map();
        setIndex(0);
        setAll(false);
        setPending({ items, dest, verb, resolve });
      }),
    [],
  );

  const choose = (p: ConflictPolicy) => {
    if (!pending) return;
    const rest = all ? pending.items.slice(index) : [pending.items[index]!];
    for (const it of rest) answers.current.set(it.name, p);
    const next = all ? pending.items.length : index + 1;
    if (next >= pending.items.length) {
      pending.resolve(answers.current);
      setPending(null);
    } else setIndex(next);
  };
  const cancel = () => {
    pending?.resolve(null);
    setPending(null);
  };

  const node = pending ? <ConflictDialog pending={pending} index={index} all={all} setAll={setAll} choose={choose} cancel={cancel} /> : null;
  return [ask, node] as const;
}

function ConflictDialog({ pending, index, all, setAll, choose, cancel }: { pending: Pending; index: number; all: boolean; setAll: (v: boolean) => void; choose: (p: ConflictPolicy) => void; cancel: () => void }) {
  const fmt = useFormat();
  const it = pending.items[index]!;
  const left = pending.items.length - index - 1;
  const what = it.isDir ? "folder" : "file";
  const mergeFolder = pending.verb === "upload" && it.isDir;
  const replaceNote = mergeFolder
    ? "Merge puts the uploaded files inside it; files with the same name are replaced and the old versions go to the trash."
    : `Replace moves the existing ${what} to the trash, so you can still get it back.`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && cancel()}
      title={`“${it.name}” is already there`}
      description={
        <>
          There's already a {what} with this name in <span className="mono">{pending.dest}</span>. {replaceNote}
        </>
      }
      footerStart={
        left > 0 ? (
          <Checkbox checked={all} onChange={setAll}>
            Do the same for the other {fmt.plural(left, "conflict")}
          </Checkbox>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button onClick={() => choose("rename")}>Keep both</Button>
          <Button variant="primary" onClick={() => choose("overwrite")}>
            {mergeFolder ? "Merge" : "Replace"}
          </Button>
        </>
      }
    >
      {it.existing && (
        <div className={s.conflictCard}>
          <KindIcon kind={it.existing.kind} type={it.existing.type} className={s.conflictIcon} />
          <div className={s.conflictText}>
            <span className="truncate" title={it.existing.name}>
              {it.existing.name}
            </span>
            <span className="muted num">
              Existing · {it.existing.size !== null ? `${fmt.bytes(it.existing.size)} · ` : ""}modified <Time ts={it.existing.mtime} />
              {it.size != null && ` · incoming ${fmt.bytes(it.size)}`}
            </span>
          </div>
        </div>
      )}
      <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: it.existing ? 12 : 0 }}>
        Keep both saves the new one as “{it.name.replace(/(\.[^.]+)?$/, " (2)$1")}”.
      </p>
    </Dialog>
  );
}
