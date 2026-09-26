"use client";
import * as React from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Computer, Drag, EditPencil, Folder, MoreHoriz, PinSlash, Trash } from "iconoir-react";
import type { Place, Places } from "@/lib/files-types";
import { api } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { DiskGlyph } from "@/components/storage/DiskGlyph";
import { IconButton, Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { PlaceIcon, useDropTarget } from "./lib";
import s from "./files.module.css";

interface Props {
  places: Places | undefined;
  current: string | null;
  trashOpen: boolean;
  onNavigate: (path: string) => void;
  onOpenTrash: () => void;
  onDropItems: (sources: string[], dest: string, copy: boolean) => void;
  onPinsChanged: () => void;
}

const SECTION_TITLE: Record<string, string> = { drives: "Drives", homes: "Home folders", apps: "App folders", shared: "Shared with you" };
const SECTION_ORDER = ["shared", "drives", "homes", "apps"] as const;

/**
 * Places, in sections: drives (with how full they are), people's home folders, the folders apps keep
 * files in (with the apps' icons), pinned folders you can reorder, recent folders, and the trash.
 */
export function Rail({ places, current, trashOpen, onNavigate, onOpenTrash, onDropItems, onPinsChanged }: Props) {
  const [pins, setPins] = React.useState<Place[]>(places?.pins ?? []);
  const [renaming, setRenaming] = React.useState<Place | null>(null);
  React.useEffect(() => setPins(places?.pins ?? []), [places?.pins]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  if (!places) {
    return (
      <div className={s.railInner} aria-busy>
        {[3, 2, 3].map((n, g) => (
          <div key={g} className={s.railGroup}>
            <Skeleton width={70} height={10} style={{ margin: "0 10px 10px" }} />
            {Array.from({ length: n }, (_, i) => (
              <Skeleton key={i} height={g === 0 ? 62 : 34} style={{ marginBottom: 2 }} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const onEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = pins.map((p) => p.id);
    const next = arrayMove(pins, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setPins(next);
    try {
      await api.patch("/api/me/pins", { order: next.map((p) => p.pinned!.id) });
      onPinsChanged();
    } catch (err) {
      setPins(places.pins);
      toast.error("Couldn't reorder pins", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const unpin = async (p: Place) => {
    try {
      await api.del("/api/me/pins", { id: p.pinned!.id });
      onPinsChanged();
    } catch (err) {
      toast.error("Couldn't unpin", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const bySection = new Map<string, Place[]>();
  for (const p of places.places) {
    const sec = p.section ?? (p.kind === "grant" ? "shared" : p.kind === "home" ? "homes" : p.kind === "media" || p.kind === "data" ? "apps" : "drives");
    bySection.set(sec, [...(bySection.get(sec) ?? []), p]);
  }
  const isActive = (p: Place) => !trashOpen && current === p.path;

  return (
    <nav className={s.railInner} aria-label="Places">
      {!places.admin && places.places.length === 0 && (
        <div className={s.railGroup}>
          <div className={`label ${s.railLabel}`}>Shared with you</div>
          <p className={s.railEmpty}>No folders have been shared with you yet. Ask an admin to share one.</p>
        </div>
      )}
      {SECTION_ORDER.filter((k) => bySection.has(k)).map((k) => (
        <div key={k} className={s.railGroup} role="group" aria-labelledby={`rail-${k}`}>
          <div className={`label ${s.railLabel}`} id={`rail-${k}`}>
            {SECTION_TITLE[k]}
          </div>
          {bySection.get(k)!.map((p) =>
            k === "drives" || k === "shared" ? (
              <DriveRow key={p.id} place={p} active={isActive(p)} onNavigate={onNavigate} onDropItems={onDropItems} />
            ) : (
              <PlaceRow key={p.id} place={p} active={isActive(p)} onNavigate={onNavigate} onDropItems={onDropItems} />
            ),
          )}
        </div>
      ))}

      <div className={s.railGroup} role="group" aria-labelledby="rail-pins">
        <div className={`label ${s.railLabel}`} id="rail-pins">
          Pinned
        </div>
        {pins.length === 0 ? (
          <p className={s.railEmpty}>Pin a folder you open often with the pin button at the top of the page.</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onEnd(e)}>
            <SortableContext items={pins.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              {pins.map((p) => (
                <PinRow key={p.id} place={p} active={isActive(p)} onNavigate={onNavigate} onDropItems={onDropItems} onRename={() => setRenaming(p)} onUnpin={() => void unpin(p)} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {places.recent.length > 0 && (
        <div className={s.railGroup} role="group" aria-labelledby="rail-recent">
          <div className={`label ${s.railLabel}`} id="rail-recent">
            Recent
          </div>
          {places.recent.slice(0, 5).map((p) => (
            <PlaceRow key={p.id} place={p} active={false} compact onNavigate={onNavigate} onDropItems={onDropItems} />
          ))}
        </div>
      )}

      <div className={s.railGroup}>
        <button type="button" className={s.railItem} data-active={trashOpen ? "" : undefined} onClick={onOpenTrash} aria-current={trashOpen ? "page" : undefined}>
          <Trash aria-hidden className={s.railIcon} />
          <span className={s.railText}>
            <span className="truncate">Trash</span>
          </span>
        </button>
      </div>

      <RenamePin place={renaming} onClose={() => setRenaming(null)} onDone={onPinsChanged} />
    </nav>
  );
}

/** A drive (or a shared root): its name, how full it is as a readable meter, and what's free. */
function DriveRow({ place: p, active, onNavigate, onDropItems }: { place: Place; active: boolean; onNavigate: (path: string) => void; onDropItems: Props["onDropItems"] }) {
  const fmt = useFormat();
  const drop = useDropTarget(p.missing || (p.kind === "drive" && !p.fs) ? null : p.path, onDropItems, p.access === "write");
  // A shared folder isn't a drive: how full the disk under it is would only confuse; say what's free.
  const pct = p.kind !== "grant" && p.fs && p.fs.size ? (p.fs.used / p.fs.size) * 100 : null;
  const missing = p.missing || (p.kind === "drive" && !p.fs);
  const level = pct === null ? "normal" : pct >= 95 ? "fault" : pct >= 85 ? "attention" : "normal";
  const free = p.fs ? `${fmt.bytes(p.fs.avail)} free of ${fmt.bytes(p.fs.size)}` : null;
  return (
    <button
      type="button"
      className={s.railItem}
      data-drive=""
      data-active={active ? "" : undefined}
      data-drop={drop.over ? "" : undefined}
      data-missing={missing ? "" : undefined}
      onClick={() => onNavigate(p.path)}
      title={p.path}
      aria-current={active ? "page" : undefined}
      aria-label={[p.label, missing ? (p.kind === "grant" ? "missing" : "not connected") : free, p.kind === "grant" ? p.detail : null].filter(Boolean).join(", ")}
      {...drop.props}
    >
      {p.kind === "root" ? <Computer aria-hidden className={s.railIcon} /> : p.kind === "grant" ? <Folder aria-hidden className={s.railIcon} /> : <DiskGlyph media={p.media} className={s.railIcon} />}
      <span className={s.railText}>
        <span className={s.railTop}>
          <span className="truncate">{p.label}</span>
          {pct !== null && (
            <span className={`${s.railPct} num`} data-level={level}>
              {level === "fault" && <span className={s.faultMark} aria-hidden />}
              {Math.round(pct)}%
            </span>
          )}
        </span>
        {pct !== null && (
          <span className={s.meter} data-level={level} aria-hidden>
            <span style={{ width: `${Math.max(1.5, pct)}%` }} />
            <i style={{ left: "85%" }} />
          </span>
        )}
        <span className={`${s.railSub} truncate num`}>{missing ? (p.kind === "grant" ? "Missing" : "Not connected") : p.kind === "grant" ? [p.detail, p.fs ? `${fmt.bytes(p.fs.avail)} free` : null].filter(Boolean).join(" · ") : free}</span>
      </span>
    </button>
  );
}

function PlaceRow({ place: p, active, compact, onNavigate, onDropItems }: { place: Place; active: boolean; compact?: boolean; onNavigate: (path: string) => void; onDropItems: Props["onDropItems"] }) {
  const drop = useDropTarget(p.missing ? null : p.path, onDropItems, p.access === "write");
  const apps = p.apps ?? [];
  return (
    <button
      type="button"
      className={s.railItem}
      data-compact={compact ? "" : undefined}
      data-active={active ? "" : undefined}
      data-drop={drop.over ? "" : undefined}
      data-missing={p.missing ? "" : undefined}
      onClick={() => onNavigate(p.path)}
      title={p.path}
      aria-current={active ? "page" : undefined}
      {...drop.props}
    >
      <PlaceIcon kind={p.kind} className={s.railIcon} />
      <span className={s.railText}>
        <span className={s.railTop}>
          <span className="truncate">{p.label}</span>
          {!compact && apps.length > 0 && (
            <span className={s.railApps} aria-hidden>
              {apps.slice(0, 3).map((a) => (
                <AppIcon key={a.id} src={a.icon} name={a.name} size={16} />
              ))}
              {apps.length > 3 && <span className={`${s.railMore} num`}>+{apps.length - 3}</span>}
            </span>
          )}
        </span>
        {!compact && p.detail && p.detail !== "Home folder" && <span className={`${s.railSub} truncate`}>{p.detail}</span>}
      </span>
    </button>
  );
}

function PinRow({ place: p, active, onNavigate, onDropItems, onRename, onUnpin }: { place: Place; active: boolean; onNavigate: (path: string) => void; onDropItems: Props["onDropItems"]; onRename: () => void; onUnpin: () => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: p.id });
  const drop = useDropTarget(p.missing ? null : p.path, onDropItems);
  return (
    <div ref={setNodeRef} className={s.pinRow} data-dragging={isDragging ? "" : undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button type="button" className={s.pinGrip} {...attributes} {...listeners} aria-label={`Move ${p.label}`}>
        <Drag />
      </button>
      <button
        type="button"
        className={s.railItem}
        data-active={active ? "" : undefined}
        data-drop={drop.over ? "" : undefined}
        data-missing={p.missing ? "" : undefined}
        onClick={() => onNavigate(p.path)}
        title={p.missing ? `${p.path} — this folder is gone` : p.path}
        {...drop.props}
      >
        <PlaceIcon kind="pin" className={s.railIcon} />
        <span className={s.railText}>
          <span className="truncate">{p.label}</span>
          {p.missing && <span className={s.railSub}>Gone</span>}
        </span>
      </button>
      <Menu
        trigger={
          <IconButton label={`${p.label} options`} size="sm" className={s.pinMenu} tooltip={false}>
            <MoreHoriz />
          </IconButton>
        }
        items={[
          { label: "Rename pin", icon: <EditPencil />, onSelect: onRename },
          { label: "Unpin", icon: <PinSlash />, onSelect: onUnpin },
        ]}
      />
    </div>
  );
}

function RenamePin({ place, onClose, onDone }: { place: Place | null; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setLabel(place?.label ?? ""), [place]);
  const save = async () => {
    if (!place || !label.trim()) return;
    setBusy(true);
    try {
      await api.patch("/api/me/pins", { id: place.pinned!.id, label: label.trim() });
      onDone();
      onClose();
    } catch (e) {
      toast.error("Couldn't rename the pin", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!place}
      onOpenChange={(o) => !o && onClose()}
      title="Rename pin"
      description={place ? <span className="mono">{place.path}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name in the sidebar" description="Only changes the pin's name, not the folder.">
          <Input autoFocus value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
