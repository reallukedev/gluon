"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Surface";
import s from "./files.module.css";

/** Every Files shortcut in one place (from the bar's keyboard hint, the view menu, or ?). */
export function Shortcuts({ open, onClose, mod }: { open: boolean; onClose: () => void; mod: string }) {
  const m = mod.replace("+", "");
  const alt = mod === "⌘" ? "⌥" : "Alt";
  const groups: [string, [React.ReactNode, string][]][] = [
    [
      "The bar",
      [
        [<><Kbd>{m}</Kbd> <Kbd>F</Kbd></>, "Find, here and in every folder inside"],
        [<><Kbd>/</Kbd> or <Kbd>{m}</Kbd> <Kbd>L</Kbd></>, "Type a path; Tab completes a folder name"],
        [<Kbd key="gt">&gt;</Kbd>, "What you can do to the selection, or here"],
        [<span key="mv" className="mono">move to …</span>, "With something selected: type where it should go"],
        [<><Kbd>{m}</Kbd> <Kbd>↵</Kbd></>, "Quick look at a result"],
      ],
    ],
    [
      "Moving around",
      [
        [<><Kbd>↑</Kbd> <Kbd>↓</Kbd></>, "Move through a column or list"],
        [<><Kbd>→</Kbd> or <Kbd>↵</Kbd></>, "Open the folder; in a grid, arrows move across"],
        [<><Kbd>←</Kbd>, <Kbd>⌫</Kbd> or <Kbd>Alt</Kbd> <Kbd>↑</Kbd></>, "Back to the folder it's in"],
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
        [<Kbd key="sp">Space</Kbd>, "Quick look; ← and → step through, Space or Esc closes"],
      ],
    ],
    [
      "Changing",
      [
        [<Kbd key="f2">F2</Kbd>, "Rename"],
        [<><Kbd>{m}</Kbd> <Kbd>C</Kbd> · <Kbd>{m}</Kbd> <Kbd>X</Kbd></>, "Copy or cut, then paste in another folder"],
        [<><Kbd>{m}</Kbd> <Kbd>V</Kbd></>, "Paste here"],
        [<><Kbd>{m}</Kbd> <Kbd>D</Kbd></>, "Duplicate"],
        [<><Kbd>{m}</Kbd> <Kbd>{alt}</Kbd> <Kbd>N</Kbd></>, "New folder"],
        [<><Kbd>Del</Kbd> or <Kbd>{m}</Kbd> <Kbd>⌫</Kbd></>, "Move to the trash (you can undo)"],
      ],
    ],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Keyboard shortcuts" description="Drag files onto a folder to move them; hold Alt (Option) to copy instead.">
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
