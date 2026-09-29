"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type Announcements,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { EditPencil, Plus, DragHandGesture, Settings, Trash, Check, MoreHoriz, ArrowLeft, ArrowRight } from "iconoir-react";
import { SIZES, widgetId, type HomeLayout, type Size, type WidgetItem } from "@/lib/home";
import { api } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { allWidgets, widgetDef } from "./registry";
import { Catalog } from "./Catalog";
import { StartSearch } from "./StartSearch";
import { Greeting } from "./Greeting";
import { AppsHint } from "./AppsHint";
import { Onboarding } from "./Onboarding";
import { prefersReducedMotion } from "@/lib/client/motion";
import s from "./home.module.css";

interface Props {
  initial: { layout: HomeLayout; personal: boolean };
}

/*
 * Widgets rise in once per browser session, not on every visit to Home. The server always renders the entrance
 * (it can't know), hydration keeps it, and the client snapshot turns it off for the rest of the session.
 */
const ENTERED = "gluon.home.entered";
let enterSnapshot: boolean | null = null;
function clientEnter() {
  if (enterSnapshot === null) {
    try {
      enterSnapshot = !sessionStorage.getItem(ENTERED);
      sessionStorage.setItem(ENTERED, "1");
    } catch {
      enterSnapshot = false;
    }
  }
  return enterSnapshot;
}
const noopSubscribe = () => () => {};
function useEntrance() {
  const enter = React.useSyncExternalStore(noopSubscribe, clientEnter, () => true);
  React.useEffect(() => {
    // Once this mount has played it, later mounts (client navigation back to Home) stay still.
    const t = setTimeout(() => (enterSnapshot = false), 1200);
    return () => clearTimeout(t);
  }, []);
  return enter;
}

/** FLIP: when order changes, animate each widget from its old position to its new one. */
function useFlip(container: React.RefObject<HTMLElement | null>, key: string) {
  const rects = React.useRef(new Map<string, DOMRect>());
  const capture = React.useCallback(() => {
    const el = container.current;
    if (!el) return;
    rects.current = new Map([...el.querySelectorAll<HTMLElement>("[data-widget]")].map((n) => [n.dataset.widget!, n.getBoundingClientRect()]));
  }, [container]);
  React.useLayoutEffect(() => {
    const el = container.current;
    if (!el || !rects.current.size) return;
    if (prefersReducedMotion()) return;
    for (const n of el.querySelectorAll<HTMLElement>("[data-widget]")) {
      const before = rects.current.get(n.dataset.widget!);
      if (!before) continue;
      const after = n.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 260, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
    }
    rects.current = new Map();
  }, [container, key]);
  return capture;
}

export function Home({ initial }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, prefs } = usePrefs();
  const [layout, setLayout] = React.useState(initial.layout);
  const [personal, setPersonal] = React.useState(initial.personal);
  const [editing, setEditing] = React.useState(params.get("edit") === "1");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  // The widget just added from the catalog fades up once; everything else mounts still.
  const [freshId, setFreshId] = React.useState<string | null>(null);
  // The edit bar stays mounted for one beat after Done so it can leave by the edge it came from.
  const [barMounted, setBarMounted] = React.useState(editing);
  if (editing && !barMounted) setBarMounted(true);
  React.useEffect(() => {
    if (editing) return;
    const t = setTimeout(() => setBarMounted(false), 220);
    return () => clearTimeout(t);
  }, [editing]);
  const [catalogOpen, setCatalogOpen] = React.useState(false);
  const [settingsFor, setSettingsFor] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [confirm, confirmNode] = useConfirm();
  const gridRef = React.useRef<HTMLDivElement>(null);
  const capture = useFlip(gridRef, layout.items.map((i) => `${i.id}:${i.size}`).join(","));
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = React.useRef(layout);
  latest.current = layout;
  const enter = useEntrance();

  const items = layout.items.filter((i) => {
    const d = widgetDef(i.type);
    return d && (!d.adminOnly || viewer.role === "admin");
  });

  // Leave ?edit=1 out of the URL once consumed.
  React.useEffect(() => {
    if (params.get("edit")) router.replace("/", { scroll: false });
  }, [params, router]);

  const persist = React.useCallback((next: HomeLayout, immediate = false) => {
    clearTimeout(saveTimer.current);
    setSaving("saving");
    const go = async () => {
      try {
        await api.put("/api/me/home", { layout: next });
        setPersonal(true);
        setSaving("saved");
      } catch (e) {
        setSaving("error");
        toast.error("Couldn't save your home page", {
          description: e instanceof Error ? e.message : undefined,
        });
      }
    };
    if (immediate) void go();
    else saveTimer.current = setTimeout(go, 500);
  }, []);

  const change = React.useCallback(
    (fn: (items: WidgetItem[]) => WidgetItem[], opts: { animate?: boolean; immediate?: boolean } = {}) => {
      if (opts.animate !== false) capture();
      const next = { ...latest.current, items: fn(latest.current.items) };
      setLayout(next);
      persist(next, opts.immediate);
    },
    [capture, persist],
  );

  const updateConfig = React.useCallback(
    (id: string, patch: Record<string, unknown>) => change((its) => its.map((i) => (i.id === id ? { ...i, config: { ...i.config, ...patch } } : i)), { animate: false }),
    [change],
  );

  // ---- drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const nameOf = (id: string | number) => {
    const it = layout.items.find((i) => i.id === id);
    const d = it ? widgetDef(it.type) : undefined;
    return (d && it && (d.title?.(it.config as never) ?? d.label?.(it.config as never) ?? d.name)) || "widget";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}. Use the arrow keys to move it, space to drop.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} moved to position ${items.findIndex((i) => i.id === over.id) + 1} of ${items.length}.` : undefined),
    onDragEnd: ({ active }) => `Dropped ${nameOf(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${nameOf(active.id)}.`,
  };
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    change(
      (its) => {
        const from = its.findIndex((i) => i.id === active.id);
        const to = its.findIndex((i) => i.id === over.id);
        return from < 0 || to < 0 ? its : arrayMove(its, from, to);
      },
      { animate: true },
    );
  };
  const onDragEnd = () => setActiveId(null);

  // ---- actions
  function addWidget(type: string, config?: Record<string, unknown>) {
    const d = widgetDef(type);
    if (!d) return;
    const item: WidgetItem = {
      id: widgetId(),
      type,
      size: d.defaultSize,
      config: {
        ...(structuredClone(d.defaultConfig) as Record<string, unknown>),
        ...(config ?? {}),
      },
    };
    change((its) => [item, ...its], { immediate: true });
    setFreshId(item.id);
    setCatalogOpen(false);
    setEditing(true);
    toast.success(d.perApp ? "Added an app tile" : `Added ${d.name}`, {
      description: "It's at the top. Drag it wherever you like.",
    });
    requestAnimationFrame(() => document.querySelector(`[data-widget="${item.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  function moveWidget(id: string, by: -1 | 1) {
    change((its) => {
      const visible = its.filter((i) => items.some((x) => x.id === i.id));
      const at = visible.findIndex((i) => i.id === id);
      const other = visible[at + by];
      if (at < 0 || !other) return its;
      return arrayMove(
        its,
        its.findIndex((i) => i.id === id),
        its.findIndex((i) => i.id === other.id),
      );
    });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-widget="${id}"] [data-handle]`)?.focus());
  }

  function removeWidget(id: string) {
    const index = latest.current.items.findIndex((i) => i.id === id);
    const removed = latest.current.items[index];
    if (!removed) return;
    change((its) => its.filter((i) => i.id !== id), { immediate: true });
    toast.info(`Removed ${widgetDef(removed.type)?.name ?? "widget"}`, {
      action: {
        label: "Undo",
        onClick: () =>
          change(
            (its) => {
              const copy = [...its];
              copy.splice(Math.min(index, copy.length), 0, removed);
              return copy;
            },
            { immediate: true },
          ),
      },
    });
  }

  async function resetToDefault() {
    const r = await api.del<{ layout: HomeLayout; personal: boolean }>("/api/me/home");
    capture();
    setLayout(r.layout);
    setPersonal(r.personal);
    toast.success("Back to the default home page");
  }

  async function saveAsHouseholdDefault() {
    await api.put("/api/home/default", { layout: latest.current });
    toast.success("Saved as the household's default", {
      description: "New members start with this. People who've customised theirs keep their own.",
    });
  }

  const active = activeId ? layout.items.find((i) => i.id === activeId) : null;
  const settingsItem = settingsFor ? layout.items.find((i) => i.id === settingsFor) : null;
  const settingsDef = settingsItem ? widgetDef(settingsItem.type) : null;

  return (
    <div className={s.page} data-width={prefs.homeWidth}>
      <header className={s.head}>
        <Greeting />
        <div className={s.headActions}>
          {!editing && (
            <Button variant="ghost" icon={<EditPencil />} onClick={() => setEditing(true)}>
              Customise
            </Button>
          )}
        </div>
      </header>
      {prefs.onboarding === "pending" && !editing && <Onboarding />}
      <StartSearch />
      {viewer.role === "admin" && !editing && (
        <AppsHint
          items={layout.items}
          onOpen={() => {
            setEditing(true);
            setCatalogOpen(true);
          }}
        />
      )}

      {(editing || barMounted) && (
        <div
          className={s.editBar}
          role="region"
          aria-label="Customising your home page"
          data-motion-gentle=""
          data-leaving={editing ? undefined : ""}
          inert={!editing || undefined}
        >
          <span className={s.editText}>
            Drag a widget by its name to move it. Pick a shape to resize it, or use <MoreHoriz className={s.inlineIcon} aria-label="More" /> to move or remove it.
            <span className={s.saveState} aria-live="polite">
              {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "error" ? "Not saved" : ""}
            </span>
          </span>
          <div className={s.editActions}>
            <Button icon={<Plus />} onClick={() => setCatalogOpen(true)}>
              Add widget
            </Button>
            <Menu
              trigger={
                <Button variant="ghost" iconEnd={<MoreHoriz />}>
                  More
                </Button>
              }
              items={[
                ...(viewer.role === "admin"
                  ? [
                      {
                        label: "Make this the household default",
                        description: "What new members start with",
                        onSelect: () =>
                          confirm({
                            title: "Use this layout for the household?",
                            consequences: [
                              "New household members will start with this home page.",
                              "People who've already customised theirs keep their own.",
                              "Admin-only widgets are hidden from members automatically.",
                            ],
                            confirmLabel: "Make it the default",
                            variant: "primary",
                            onConfirm: saveAsHouseholdDefault,
                          }),
                      } as MenuEntry,
                    ]
                  : []),
                {
                  label: "Reset to the default",
                  disabled: !personal,
                  onSelect: () =>
                    confirm({
                      title: "Reset your home page?",
                      consequences: ["Your widgets, links and notes on this page will be replaced with the default layout."],
                      confirmLabel: "Reset",
                      onConfirm: resetToDefault,
                    }),
                },
              ]}
            />
            <Button variant="primary" icon={<Check />} onClick={() => setEditing(false)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className={s.emptyHome}>
          <p className={s.emptyTitle}>Your home page is empty</p>
          <p className={s.emptyBody}>Add the things you check every day: your apps, the weather, what's playing, notes.</p>
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => {
              setEditing(true);
              setCatalogOpen(true);
            }}
          >
            Add a widget
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragEnd}
          accessibility={{ announcements }}
        >
          <SortableContext items={items.map((i) => i.id)} strategy={() => null}>
            <div className={s.grid} ref={gridRef} data-editing={editing ? "" : undefined} data-enter={enter ? "" : undefined}>
              {items.map((item, index) => (
                <SortableWidget
                  key={item.id}
                  index={index}
                  first={index === 0}
                  last={index === items.length - 1}
                  onMove={(by) => moveWidget(item.id, by)}
                  fresh={freshId === item.id}
                  item={item}
                  editing={editing}
                  dragging={activeId === item.id}
                  onResize={(size) => change((its) => its.map((i) => (i.id === item.id ? { ...i, size } : i)))}
                  onRemove={() => removeWidget(item.id)}
                  onSettings={() => setSettingsFor(item.id)}
                  update={(patch) => updateConfig(item.id, patch)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay
            dropAnimation={{
              duration: 200,
              easing: "cubic-bezier(0.23, 1, 0.32, 1)",
            }}
          >
            {active ? <WidgetFrame item={active} editing overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <Catalog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onAdd={addWidget}
        widgets={allWidgets().filter((w) => !w.adminOnly || viewer.role === "admin")}
        existing={layout.items}
      />

      {settingsItem && settingsDef?.Settings && (
        <WidgetSettingsDialog
          item={settingsItem}
          onClose={() => setSettingsFor(null)}
          onSave={(config) => {
            change((its) => its.map((i) => (i.id === settingsItem.id ? { ...i, config } : i)), { animate: false, immediate: true });
            setSettingsFor(null);
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function WidgetSettingsDialog({ item, onClose, onSave }: { item: WidgetItem; onClose: () => void; onSave: (c: Record<string, unknown>) => void }) {
  const def = widgetDef(item.type)!;
  const [config, setConfig] = React.useState(item.config);
  const S = def.Settings!;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${def.name} settings`}
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(config)}>
            Save
          </Button>
        </>
      }
    >
      <S config={config} onChange={setConfig} />
    </Dialog>
  );
}

interface SortableProps {
  item: WidgetItem;
  fresh: boolean;
  index: number;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  editing: boolean;
  dragging: boolean;
  onResize: (s: Size) => void;
  onRemove: () => void;
  onSettings: () => void;
  update: (patch: Record<string, unknown>) => void;
}

function SortableWidget({ item, fresh, index, first, last, onMove, editing, dragging, onResize, onRemove, onSettings, update }: SortableProps) {
  const { setNodeRef, attributes, listeners, setActivatorNodeRef } = useSortable({ id: item.id, disabled: !editing });
  return (
    <WidgetFrame
      item={item}
      fresh={fresh}
      index={index}
      first={first}
      last={last}
      onMove={onMove}
      editing={editing}
      dragging={dragging}
      nodeRef={setNodeRef}
      handleRef={setActivatorNodeRef}
      handleProps={{ ...attributes, ...listeners }}
      onResize={onResize}
      onRemove={onRemove}
      onSettings={onSettings}
      update={update}
    />
  );
}

interface FrameProps {
  item: WidgetItem;
  fresh?: boolean;
  index?: number;
  first?: boolean;
  last?: boolean;
  onMove?: (by: -1 | 1) => void;
  editing: boolean;
  dragging?: boolean;
  overlay?: boolean;
  nodeRef?: (el: HTMLElement | null) => void;
  handleRef?: (el: HTMLElement | null) => void;
  handleProps?: Record<string, unknown>;
  onResize?: (s: Size) => void;
  onRemove?: () => void;
  onSettings?: () => void;
  update?: (patch: Record<string, unknown>) => void;
}

/** A widget size drawn as its own shape, so resizing reads as picking an outline. */
function SizeGlyph({ size }: { size: Size }) {
  const { cols, rows } = SIZES[size];
  const w = cols * 2 + 2;
  const h = rows * 3;
  return (
    <svg className={s.glyph} viewBox="0 0 26 14" aria-hidden>
      <rect x={(26 - w) / 2 + 0.5} y={(14 - h) / 2 + 0.5} width={w - 1} height={h - 1} rx={1.5} />
    </svg>
  );
}

const WidgetFrame = React.memo(function WidgetFrame({
  item,
  fresh,
  index = 0,
  first,
  last,
  onMove,
  editing,
  dragging,
  overlay,
  nodeRef,
  handleRef,
  handleProps,
  onResize,
  onRemove,
  onSettings,
  update,
}: FrameProps) {
  const def = widgetDef(item.type);
  if (!def) return null;
  const title = def.title?.(item.config as never) ?? null;
  const C = def.Component;
  const size = SIZES[item.size];
  const showTitle = !!title && !editing;
  const label = title ?? def.label?.(item.config as never) ?? def.name;
  return (
    <section
      ref={nodeRef}
      data-widget={item.id}
      className={s.widget}
      data-size={item.size}
      data-type={item.type}
      data-titled={showTitle ? "" : undefined}
      data-fresh={fresh ? "" : undefined}
      data-motion-gentle=""
      data-dragging={dragging ? "" : undefined}
      data-overlay={overlay ? "" : undefined}
      style={
        {
          "--cols": size.cols,
          "--rows": size.rows,
          "--i": Math.min(index, 10),
        } as React.CSSProperties
      }
      aria-label={label}
    >
      {editing && (
        <div className={s.chrome}>
          <button type="button" className={s.handle} ref={handleRef} {...handleProps} data-handle="" aria-label={`Move ${label}. Use the arrow keys after picking it up.`}>
            <DragHandGesture />
            <span>{label}</span>
          </button>
          {def.sizes.length > 1 && size.cols < 6 && (
            <Menu
              trigger={
                <button type="button" className={`${s.sizeBtn} ${s.sizeOne}`} aria-label={`Size: ${size.label}. Change size`} title="Change size">
                  <SizeGlyph size={item.size} />
                </button>
              }
              items={def.sizes.map((sz) => ({
                kind: "check" as const,
                label: SIZES[sz].label,
                checked: item.size === sz,
                onChange: () => onResize?.(sz),
              }))}
            />
          )}
          {def.sizes.length > 1 && size.cols >= 6 && (
            <div className={s.sizes} role="radiogroup" aria-label={`${def.name} size`}>
              {def.sizes.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  role="radio"
                  aria-checked={item.size === sz}
                  aria-label={SIZES[sz].label}
                  title={SIZES[sz].label}
                  className={s.sizeBtn}
                  onClick={() => onResize?.(sz)}
                >
                  <SizeGlyph size={sz} />
                </button>
              ))}
            </div>
          )}
          <Menu
            trigger={
              <IconButton label={`${def.name} options`} size="sm" className={s.chromeBtn}>
                <MoreHoriz />
              </IconButton>
            }
            items={[
              ...(def.sizes.length > 1
                ? [
                    {
                      kind: "sub" as const,
                      label: `Size: ${size.label}`,
                      items: def.sizes.map((sz) => ({
                        kind: "check" as const,
                        label: SIZES[sz].label,
                        checked: item.size === sz,
                        onChange: () => onResize?.(sz),
                      })),
                    },
                  ]
                : []),
              {
                label: "Move earlier",
                icon: <ArrowLeft />,
                disabled: first,
                onSelect: () => onMove?.(-1),
              },
              {
                label: "Move later",
                icon: <ArrowRight />,
                disabled: last,
                onSelect: () => onMove?.(1),
              },
              "separator",
              ...(def.Settings
                ? [
                    {
                      label: "Settings",
                      icon: <Settings />,
                      onSelect: () => onSettings?.(),
                    },
                  ]
                : []),
              {
                label: "Remove",
                icon: <Trash />,
                danger: true,
                onSelect: () => onRemove?.(),
              },
            ]}
          />
        </div>
      )}
      {showTitle && <h2 className={s.widgetTitle}>{title}</h2>}
      <div className={s.body} inert={editing || undefined}>
        <C item={item} size={item.size} editing={editing} update={update ?? (() => undefined)} />
      </div>
    </section>
  );
});
