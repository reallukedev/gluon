"use client";
import * as React from "react";
import Link from "next/link";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Drag } from "iconoir-react";
import { hintFor, orderedNav, SETTINGS_JUMPS, SETTINGS_KEY } from "@/lib/nav";
import { useNavAccess } from "@/components/shell/Shell";
import { usePrefs } from "@/components/PrefsProvider";
import { Panel, Kbd } from "@/components/ui/Surface";
import { SettingRow, Switch } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { useSet } from "./personal";
import s from "./settings.module.css";

/*
 * Settings → Navigation. Its own module (loaded with the section, like the server-wide ones) so the
 * drag-and-drop library isn't part of every Settings page.
 */

function SortRow({ id, label, hint, hidden, locked, onToggle }: { id: string; label: string; hint: string; hidden: boolean; locked: boolean; onToggle: (v: boolean) => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <li ref={setNodeRef} className={s.sortItem} data-dragging={isDragging ? "" : undefined} data-hidden={hidden ? "" : undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button type="button" className={s.grip} {...attributes} {...listeners} aria-label={`Move ${label}`}>
        <Drag />
      </button>
      <span className={s.sortLabel}>
        {label}
        <small>{hint}</small>
      </span>
      <Switch checked={!hidden} onChange={onToggle} disabled={locked} aria-label={`Show ${label} in the sidebar`} />
    </li>
  );
}

export function Navigation() {
  const { prefs, viewer } = usePrefs();
  const access = useNavAccess();
  const set = useSet();
  const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, access).all;
  // Old ids (like "alerts", now part of Status) don't count as a change.
  const usual = orderedNav(viewer.role, [], [], access).all;
  const customised = nav.some((n, i) => n.id !== usual[i]?.id || prefs.sidebarHidden.includes(n.id));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const dndId = React.useId();
  const label = (id: string | number) => nav.find((n) => n.id === String(id))?.label ?? "Page";
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = nav.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    void set({ sidebarOrder: next });
  };
  return (
    <div className={s.stack}>
      <Panel
        title="Sidebar"
        flush
        meta={
          customised ? (
            <Button size="sm" variant="ghost" onClick={() => void set({ sidebarOrder: [], sidebarHidden: [] })}>
              Back to the usual order
            </Button>
          ) : undefined
        }
      >
        <div style={{ padding: "12px 16px 16px" }}>
          <p className={s.hint} style={{ marginBottom: 12 }}>
            Drag the handle to reorder, or focus it and use Space and the arrow keys. Switch off what you don't use; it stays reachable with <Kbd>⌘K</Kbd>. Changes
            show in the sidebar straight away.
          </p>
          <DndContext
            id={dndId}
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onEnd}
            accessibility={{
              screenReaderInstructions: { draggable: "To move a page, press Space, use the up and down arrow keys, then press Space again to drop it, or Escape to cancel." },
              announcements: {
                onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
                onDragOver: ({ active, over }) => (over ? `${label(active.id)} is now at position ${nav.findIndex((n) => n.id === over.id) + 1} of ${nav.length}.` : undefined),
                onDragEnd: ({ active, over }) => (over ? `Dropped ${label(active.id)} at position ${nav.findIndex((n) => n.id === over.id) + 1}.` : `Dropped ${label(active.id)}.`),
                onDragCancel: ({ active }) => `Cancelled. ${label(active.id)} is back where it was.`,
              },
            }}
          >
            <SortableContext items={nav.map((n) => n.id)} strategy={verticalListSortingStrategy}>
              <ul className={s.sortList} role="list">
                {nav.map((n) => (
                  <SortRow
                    key={n.id}
                    id={n.id}
                    label={n.label}
                    hint={n.id === "home" ? "Always shown" : hintFor(n, viewer.role)}
                    hidden={prefs.sidebarHidden.includes(n.id)}
                    locked={n.id === "home"}
                    onToggle={(v) => void set({ sidebarHidden: v ? prefs.sidebarHidden.filter((x) => x !== n.id) : [...prefs.sidebarHidden, n.id] })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      </Panel>
      <Panel title="Keyboard">
        <SettingRow label="Single-key shortcuts" description="Letters and / as shortcuts when you're not typing. ⌘K always works.">
          <Switch checked={prefs.shortcuts} onChange={(v) => void set({ shortcuts: v })} aria-label="Single-key shortcuts" />
        </SettingRow>
        <dl className={s.keys} style={{ marginTop: 12 }}>
          <dt>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </dt>
          <dd>Search and jump anywhere</dd>
          <dt>
            <Kbd>/</Kbd>
          </dt>
          <dd>Search (on Home: the web search box)</dd>
          {[
            ...nav.map((n) => ({ id: n.id, key: n.key, label: n.label })),
            { id: "settings", key: SETTINGS_KEY, label: "Settings" },
            ...(viewer.role === "admin" ? SETTINGS_JUMPS.map((j) => ({ id: j.href, key: j.key, label: `Settings → ${j.label}` })) : []),
          ].map((n) => (
            <React.Fragment key={n.id}>
              <dt>
                <Kbd>g</Kbd>
                <Kbd>{n.key}</Kbd>
              </dt>
              <dd>Go to {n.label}</dd>
            </React.Fragment>
          ))}
        </dl>
      </Panel>
      <p className={s.hint}>
        Collapse the sidebar to icons with the button next to the server's name. <Link href="/settings/home">Home page settings</Link>
      </p>
    </div>
  );
}
