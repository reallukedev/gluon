"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Surface";
import s from "./files.module.css";

/** Every Files shortcut in one place (opened from More, or with ?). */
export function Shortcuts({ open, onClose, mod }: { open: boolean; onClose: () => void; mod: string }) {
  const m = mod.replace("+", "");
  const groups: [string, [React.ReactNode, string][]][] = [
    [
      "Moving around",
      [
        [<><Kbd>↑</Kbd> <Kbd>↓</Kbd></>, "Move through the list (arrows move across in the grid)"],
        [<Kbd key="e">↵</Kbd>, "Open the folder or file"],
        [<><Kbd>⌫</Kbd> or <Kbd>Alt</Kbd> <Kbd>↑</Kbd></>, "Go up a folder"],
        [<Kbd key="h">Home</Kbd>, "First item (End for the last)"],
        [<span key="t" className="muted">Type a name</span>, "Jump to it"],
      ],
    ],
    [
      "Choosing",
      [
        [<><Kbd>⇧</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd></>, "Select a range (or ⇧-click)"],
        [<><Kbd>{m}</Kbd> <Kbd>A</Kbd></>, "Select everything here"],
        [<Kbd key="esc">Esc</Kbd>, "Clear the selection"],
        [<Kbd key="sp">Space</Kbd>, "Preview; ← and → step through, Space closes"],
      ],
    ],
    [
      "Changing",
      [
        [<Kbd key="f2">F2</Kbd>, "Rename"],
        [<><Kbd>{m}</Kbd> <Kbd>C</Kbd> · <Kbd>{m}</Kbd> <Kbd>X</Kbd></>, "Copy or cut, then paste in another folder"],
        [<><Kbd>{m}</Kbd> <Kbd>V</Kbd></>, "Paste here"],
        [<><Kbd>{m}</Kbd> <Kbd>D</Kbd></>, "Duplicate"],
        [<><Kbd>{m}</Kbd> <Kbd>⇧</Kbd> <Kbd>N</Kbd></>, "New folder"],
        [<><Kbd>Del</Kbd> or <Kbd>{m}</Kbd> <Kbd>⌫</Kbd></>, "Move to the trash (you can undo)"],
      ],
    ],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Keyboard shortcuts" description="Click a file or folder first, then use these.">
      <div className={s.keys}>
        {groups.map(([title, rows]) => (
          <section key={title}>
            <h3 className={`label ${s.keysLabel}`}>{title}</h3>
            <dl>
              {rows.map(([k, what], i) => (
                <React.Fragment key={i}>
                  <dt>{k}</dt>
                  <dd>{what}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
