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
import { Check, DragHandGesture, MoreHoriz, ArrowLeft, ArrowRight, Settings, PinSlash, Pin, OpenNewWindow, Copy, ViewGrid } from "iconoir-react";
import { SIZES, ALL_APPS, appInsertIndex, appItem, insertIndex, widgetId, type HomeLayout, type Size, type WidgetItem } from "@/lib/home";
import { api } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { usePrefs } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { allWidgets, widgetDef } from "./registry";
import { AppsHint } from "./AppsHint";
import { HOME_KEY, useHomeLayout, type HomeData } from "./pinned";
import { HomeContext, type CollectionSection } from "./context";
import type { WidgetDef } from "./types";
import { prefersReducedMotion } from "@/lib/client/motion";
import { mutate as mutateGlobal } from "swr";
import s from "./home.module.css";

interface Props {
  initial: HomeData;
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

/** Widgets don't shift while something is dragged: the order changes live instead (onDragOver). */
const noStrategy = () => null;

/** What a thing on Home is called in menus and announcements: its title, its label (an app's name), or its kind. */
function nameFor(it: WidgetItem, d: WidgetDef | undefined): string {
  if (!d) return "this";
  return d.title?.(it.config as never) ?? d.label?.(it.config as never) ?? d.name;
}

const sizeLabel = (d: WidgetDef, z: Size) => d.sizeLabels?.[z] ?? SIZES[z].label;

/** The Collection is only needed once someone opens it, so its code loads then (or when a pointer or focus heads for its button). */
type CollectionView = typeof import("./Collection").Collection;
const loadCollection = () => import("./Collection").then((m) => m.Collection);

/** What a widget can ask of Home, by its id: one object for Home's lifetime, so widgets re-render only for their own changes. */
interface WidgetActions {
  move: (id: string, by: -1 | 1) => void;
  resize: (id: string, size: Size) => void;
  unpin: (id: string) => void;
  settings: (id: string) => void;
  update: (id: string, patch: Record<string, unknown>) => void;
}

/** Good first things to pin, by role, for an empty Home. */
const STARTERS: Record<"admin" | "member", { type: string; why: string }[]> = {
  admin: [
    { type: "status", why: "One sentence about the server" },
    { type: "vitals", why: "Live processor and memory" },
    { type: "household.internet", why: "Is it the internet or the server?" },
    { type: "server.space", why: "Which disk fills up first" },
  ],
  member: [
    { type: "search", why: "Jump to an app or search the web" },
    { type: "clock", why: "The time and date" },
    { type: "household.internet", why: "Is it the internet or the server?" },
    { type: "weather", why: "Now and the next hours, where you are" },
  ],
};

export function Home({ initial }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, prefs } = usePrefs();
  const admin = viewer.role === "admin";
  const { data } = useHomeLayout(initial);
  const layout = data?.layout ?? initial.layout;
  const personal = data?.personal ?? initial.personal;
  const [arranging, setArranging] = React.useState(params.get("edit") === "1");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  // The thing just pinned fades up once; everything else mounts still.
  const [freshId, setFreshId] = React.useState<string | null>(null);
  // The arrange bar stays mounted for one beat after Done so it can leave by the edge it came from.
  const [barMounted, setBarMounted] = React.useState(arranging);
  if (arranging && !barMounted) setBarMounted(true);
  React.useEffect(() => {
    if (arranging) return;
    const t = setTimeout(() => setBarMounted(false), 220);
    return () => clearTimeout(t);
  }, [arranging]);
  const [collection, setCollection] = React.useState<CollectionSection | "top" | null>(null);
  const [CollectionView, setCollectionView] = React.useState<CollectionView | null>(null);
  // Asked for before its code arrived: it mounts closed first, then opens, so the dialog still plays its entrance.
  const [collectionAsked, setCollectionAsked] = React.useState<CollectionSection | "top" | null>(null);
  const [settingsFor, setSettingsFor] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [confirm, confirmNode] = useConfirm();
  const gridRef = React.useRef<HTMLDivElement>(null);
  const capture = useFlip(gridRef, layout.items.map((i) => `${i.id}:${i.size}`).join(","));
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = React.useRef(layout);
  latest.current = layout;
  const enter = useEntrance();

  const visible = React.useCallback((i: WidgetItem) => {
    const d = widgetDef(i.type);
    return !!d && i.type !== ALL_APPS && (!d.adminOnly || admin);
  }, [admin]);
  const items = React.useMemo(() => layout.items.filter(visible), [layout.items, visible]);
  // The sortable context changes (and re-renders every widget) whenever these do, so they keep their identity.
  const sortableIds = React.useMemo(() => items.map((i) => i.id), [items]);

  // Leave ?edit=1 out of the URL once consumed.
  React.useEffect(() => {
    if (params.get("edit")) router.replace("/", { scroll: false });
  }, [params, router]);

  const persist = React.useCallback((next: HomeLayout, immediate = false) => {
    clearTimeout(saveTimer.current);
    setSaving("saving");
    const go = async () => {
      try {
        await api.put(HOME_KEY, { layout: next });
        setSaving("saved");
      } catch (e) {
        setSaving("error");
        toast.error("Couldn't save your Home", { description: e instanceof Error ? e.message : undefined });
      }
    };
    if (immediate) void go();
    else saveTimer.current = setTimeout(go, 500);
  }, []);

  const change = React.useCallback(
    (fn: (items: WidgetItem[]) => WidgetItem[], opts: { animate?: boolean; immediate?: boolean } = {}) => {
      if (opts.animate !== false) capture();
      const next = { ...latest.current, items: fn(latest.current.items) };
      latest.current = next;
      void mutateGlobal<HomeData>(HOME_KEY, { layout: next, personal: true }, { revalidate: false });
      persist(next, opts.immediate);
    },
    [capture, persist],
  );

  const updateConfig = React.useCallback(
    (id: string, patch: Record<string, unknown>) => change((its) => its.map((i) => (i.id === id ? { ...i, config: { ...i.config, ...patch } } : i)), { animate: false }),
    [change],
  );

  // ---- drag and drop (arrange mode)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number) => {
    const it = layout.items.find((i) => i.id === id);
    return it ? nameFor(it, widgetDef(it.type)) : "item";
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
    change((its) => {
      const from = its.findIndex((i) => i.id === active.id);
      const to = its.findIndex((i) => i.id === over.id);
      return from < 0 || to < 0 ? its : arrayMove(its, from, to);
    });
  };
  const onDragEnd = () => setActiveId(null);

  // ---- pin and unpin
  function pin(type: string, config?: Record<string, unknown>) {
    const d = widgetDef(type);
    if (!d) return;
    const item: WidgetItem =
      type === "app" && config?.appId
        ? appItem({ id: String(config.appId), name: String(config.name ?? config.appId) }, d.defaultSize)
        : { id: widgetId(), type, size: d.defaultSize, config: { ...(structuredClone(d.defaultConfig) as Record<string, unknown>), ...(config ?? {}) } };
    if (latest.current.items.some((i) => i.id === item.id)) return;
    if (latest.current.items.length >= 80) {
      toast.error("Your Home is full", { description: "Unpin a few things first." });
      return;
    }
    change((its) => {
      const at = type === "app" ? appInsertIndex(its) : insertIndex(its);
      return [...its.slice(0, at), item, ...its.slice(at)];
    }, { immediate: true });
    setFreshId(item.id);
    // Things that are empty until set up (a link, a place) open their settings straight away.
    if (d.setupOnPin && d.Settings) {
      setCollection(null);
      setSettingsFor(item.id);
    }
  }

  const unpin = React.useCallback((ids: string[]) => {
    const before = latest.current.items;
    const gone = before.filter((i) => ids.includes(i.id));
    if (!gone.length) return;
    change((its) => its.filter((i) => !ids.includes(i.id)), { immediate: true });
    const first = gone[0]!;
    const what = gone.length === 1 ? nameFor(first, widgetDef(first.type)) : `${gone.length} items`;
    toast.info(`Unpinned ${what}`, {
      action: {
        label: "Undo",
        // Put each back where it was, relative to what's there now.
        onClick: () =>
          change((its) => {
            const copy = [...its];
            for (const g of gone) {
              if (copy.some((i) => i.id === g.id)) continue;
              copy.splice(Math.min(before.indexOf(g), copy.length), 0, g);
            }
            return copy;
          }, { immediate: true }),
      },
    });
  }, [change]);

  const moveWidget = React.useCallback((id: string, by: -1 | 1) => {
    change((its) => {
      const vis = its.filter(visible);
      const at = vis.findIndex((i) => i.id === id);
      const other = vis[at + by];
      if (at < 0 || !other) return its;
      return arrayMove(its, its.findIndex((i) => i.id === id), its.findIndex((i) => i.id === other.id));
    });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-widget="${id}"] [data-handle]`)?.focus());
  }, [change, visible]);

  const actions = React.useMemo<WidgetActions>(
    () => ({
      move: moveWidget,
      resize: (id, size) => change((its) => its.map((i) => (i.id === id ? { ...i, size } : i))),
      unpin: (id) => unpin([id]),
      settings: setSettingsFor,
      update: updateConfig,
    }),
    [change, moveWidget, unpin, updateConfig],
  );

  async function resetToDefault() {
    const r = await api.del<HomeData>(HOME_KEY);
    capture();
    latest.current = r.layout;
    await mutateGlobal<HomeData>(HOME_KEY, r, { revalidate: false });
    toast.success("Back to the default Home");
  }

  async function saveAsHouseholdDefault() {
    await api.put("/api/home/default", { layout: latest.current });
    toast.success("Saved as the household's default", { description: "New members start with this. People who've changed theirs keep their own." });
  }

  const preloadCollection = React.useCallback(() => {
    // A failed load just leaves it closed; the next click tries again.
    loadCollection().then((C) => setCollectionView(() => C), () => undefined);
  }, []);
  const openCollection = React.useCallback(
    (section?: CollectionSection) => {
      setCollectionAsked(section ?? "top");
      preloadCollection();
    },
    [preloadCollection],
  );
  React.useEffect(() => {
    if (!CollectionView || !collectionAsked) return;
    setCollection(collectionAsked);
    setCollectionAsked(null);
  }, [CollectionView, collectionAsked]);
  const ctx = React.useMemo(() => ({ openCollection, arranging }), [openCollection, arranging]);
  const active = activeId ? layout.items.find((i) => i.id === activeId) : null;
  const settingsItem = settingsFor ? layout.items.find((i) => i.id === settingsFor) : null;
  const settingsDef = settingsItem ? widgetDef(settingsItem.type) : null;
  const collectionWidgets = allWidgets().filter((w) => !w.adminOnly || admin);

  return (
    <HomeContext.Provider value={ctx}>
      <div className={s.page} data-width={prefs.homeWidth}>
        <h1 className="sr-only">Home</h1>

        {admin && !arranging && items.length > 0 && <AppsHint items={layout.items} onOpen={() => openCollection("from-apps")} />}

        {(arranging || barMounted) && (
          <div className={s.editBar} role="region" aria-label="Arranging your Home" data-motion-gentle="" data-leaving={arranging ? undefined : ""} inert={!arranging || undefined}>
            <span className={s.editText}>
              Drag anything by its name to move it. Pick a shape to resize it, or use <MoreHoriz className={s.inlineIcon} aria-label="More" /> to move or unpin it.
              <span className={s.saveState} aria-live="polite">
                {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "error" ? "Not saved" : ""}
              </span>
            </span>
            <div className={s.editActions}>
              <Button icon={<Pin />} onClick={() => openCollection()} onPointerEnter={preloadCollection} onFocus={preloadCollection}>
                Collection
              </Button>
              <Menu
                trigger={
                  <Button variant="ghost" iconEnd={<MoreHoriz />}>
                    More
                  </Button>
                }
                items={[
                  ...(admin
                    ? [
                        {
                          label: "Make this the household default",
                          description: "What new members start with",
                          onSelect: () =>
                            confirm({
                              title: "Use this Home for the household?",
                              consequences: [
                                "New household members start with this Home.",
                                "People who've already changed theirs keep their own.",
                                "Admin-only widgets are hidden from members, and so are apps that aren't shared with them.",
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
                        title: "Reset your Home?",
                        consequences: ["Everything you pinned, and your notes and links on Home, are replaced with the default."],
                        confirmLabel: "Reset",
                        onConfirm: resetToDefault,
                      }),
                  },
                ]}
              />
              <Button variant="primary" icon={<Check />} onClick={() => setArranging(false)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <EmptyHome role={admin ? "admin" : "member"} onPin={pin} onOpen={() => openCollection()} onPreload={preloadCollection} />
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
            <SortableContext items={sortableIds} strategy={noStrategy}>
              <div className={s.grid} ref={gridRef} data-editing={arranging ? "" : undefined} data-enter={enter ? "" : undefined}>
                {items.map((item, index) => (
                  <SortableWidget
                    key={item.id}
                    index={index}
                    first={index === 0}
                    last={index === items.length - 1}
                    fresh={freshId === item.id}
                    item={item}
                    editing={arranging}
                    dragging={activeId === item.id}
                    actions={actions}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>{active ? <WidgetFrame item={active} editing overlay /> : null}</DragOverlay>
          </DndContext>
        )}

        {!arranging && (
          <div className={s.foot} role="group" aria-label="Home actions">
            {items.length > 0 && (
              <Button variant="ghost" icon={<ViewGrid />} onClick={() => setArranging(true)}>
                Arrange
              </Button>
            )}
            <Button icon={<Pin />} onClick={() => openCollection()} onPointerEnter={preloadCollection} onFocus={preloadCollection}>
              Collection
            </Button>
          </div>
        )}

        {CollectionView && (
          <CollectionView
            open={collection !== null}
            onOpenChange={(o) => !o && setCollection(null)}
            section={collection === "top" ? null : collection}
            widgets={collectionWidgets}
            items={layout.items}
            onPin={pin}
            onUnpin={unpin}
          />
        )}

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
    </HomeContext.Provider>
  );
}

/** Nothing pinned at all: a calm first screen that points at the Collection, with a few good starters. */
function EmptyHome({ role, onPin, onOpen, onPreload }: { role: "admin" | "member"; onPin: (type: string) => void; onOpen: () => void; onPreload: () => void }) {
  const starters = STARTERS[role].map((x) => ({ ...x, def: widgetDef(x.type) })).filter((x): x is typeof x & { def: WidgetDef } => !!x.def);
  return (
    <section className={s.emptyHome} aria-labelledby="empty-home-title">
      <h2 id="empty-home-title" className={s.emptyTitle}>
        Nothing is pinned to your Home
      </h2>
      <p className={s.emptyBody}>Everything here is something you pin: your apps, folders, the weather, notes. The Collection has all of it.</p>
      <Button variant="primary" icon={<Pin />} onClick={onOpen} onPointerEnter={onPreload} onFocus={onPreload}>
        Open the Collection
      </Button>
      {starters.length > 0 && (
        <div className={s.starters}>
          <p className="label">Or start with</p>
          <ul role="list">
            {starters.map(({ type, why, def }) => (
              <li key={type} className={s.starter}>
                <span className={s.starterPreview} aria-hidden>
                  {def.preview}
                </span>
                <span className={s.starterText}>
                  <b>{def.name}</b>
                  <span>{why}</span>
                </span>
                <Button size="sm" icon={<Pin />} onClick={() => onPin(type)} aria-label={`Pin ${def.name}`}>
                  Pin
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function WidgetSettingsDialog({ item, onClose, onSave }: { item: WidgetItem; onClose: () => void; onSave: (c: Record<string, unknown>) => void }) {
  const def = widgetDef(item.type)!;
  const [config, setConfig] = React.useState(item.config);
  const [busy, setBusy] = React.useState(false);
  const S = def.Settings!;
  // Some widgets keep their settings on the server (the guest network): save those first, then the layout.
  const save = async () => {
    if (!def.beforeSave) return onSave(config);
    setBusy(true);
    try {
      onSave(await def.beforeSave(config));
    } catch (e) {
      toast.error("Couldn't save these settings", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${nameFor(item, def)} settings`}
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
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
  editing: boolean;
  dragging: boolean;
  actions: WidgetActions;
}

const SortableWidget = React.memo(function SortableWidget({ actions, ...props }: SortableProps) {
  const id = props.item.id;
  const { setNodeRef, attributes, listeners, setActivatorNodeRef } = useSortable({ id, disabled: !props.editing });
  const handleProps = React.useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners]);
  const onMove = React.useCallback((by: -1 | 1) => actions.move(id, by), [actions, id]);
  const onResize = React.useCallback((size: Size) => actions.resize(id, size), [actions, id]);
  const onUnpin = React.useCallback(() => actions.unpin(id), [actions, id]);
  const onSettings = React.useCallback(() => actions.settings(id), [actions, id]);
  const update = React.useCallback((patch: Record<string, unknown>) => actions.update(id, patch), [actions, id]);
  return (
    <WidgetFrame
      {...props}
      nodeRef={setNodeRef}
      handleRef={setActivatorNodeRef}
      handleProps={handleProps}
      onMove={onMove}
      onResize={onResize}
      onUnpin={onUnpin}
      onSettings={onSettings}
      update={update}
    />
  );
});

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
  onUnpin?: () => void;
  onSettings?: () => void;
  update?: (patch: Record<string, unknown>) => void;
}

/** A size drawn as its own shape, so resizing reads as picking an outline. */
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

/** What right-click / long-press did land on: a link inside the item gets its own two entries. */
function linkUnder(target: EventTarget | null): string | null {
  const a = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!a) return null;
  const href = a.getAttribute("href");
  return href && href !== "#" ? a.href : null;
}
const nativeMenu = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true']");
const noUpdate = () => undefined;

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
  onUnpin,
  onSettings,
  update,
}: FrameProps) {
  const [link, setLink] = React.useState<string | null>(null);
  const def = widgetDef(item.type);
  if (!def) return null;
  const title = def.title?.(item.config as never) ?? null;
  const C = def.Component;
  const size = SIZES[item.size] ?? SIZES[def.defaultSize];
  const showTitle = !!title && !editing;
  const label = nameFor(item, def);
  const sizeItems = def.sizes.map((sz) => ({ kind: "check" as const, label: sizeLabel(def, sz), checked: item.size === sz, onChange: () => onResize?.(sz) }));
  const extra = def.menu && update ? def.menu(item.config as never, update as never) : [];

  // The in-place menu (hover/focus button, right-click, long-press): pin-level things only, no arrange mode needed.
  const baseMenu: MenuEntry[] = [
    ...(def.sizes.length > 1 ? ([{ kind: "sub", label: `Size: ${sizeLabel(def, item.size)}`, items: sizeItems }] as MenuEntry[]) : []),
    ...extra,
    ...(def.Settings ? ([{ label: "Settings…", icon: <Settings />, onSelect: () => onSettings?.() }] as MenuEntry[]) : []),
    ...(def.sizes.length > 1 || extra.length || def.Settings ? (["separator"] as MenuEntry[]) : []),
    { label: `Unpin ${label}`, icon: <PinSlash />, onSelect: () => onUnpin?.() },
  ];
  // Right-clicking a link inside keeps the two things the browser's own menu would have offered.
  const contextMenu: MenuEntry[] = link
    ? [
        { label: "Open in a new tab", icon: <OpenNewWindow />, onSelect: () => window.open(link, "_blank", "noopener") },
        { label: "Copy address", icon: <Copy />, onSelect: () => void copyText(link).then((ok) => (ok ? toast.success("Copied the address") : toast.error("Couldn't copy it"))) },
        "separator",
        ...baseMenu,
      ]
    : baseMenu;

  const body = (
    <div
      className={s.body}
      inert={editing || undefined}
      onContextMenuCapture={(e) => {
        if (nativeMenu(e.target)) e.stopPropagation();
        else setLink(linkUnder(e.target));
      }}
      onTouchStartCapture={(e) => {
        if (nativeMenu(e.target)) e.stopPropagation();
        else setLink(null);
      }}
    >
      <C item={item} size={item.size} editing={editing} update={update ?? noUpdate} openSettings={def.Settings && onSettings ? onSettings : undefined} />
    </div>
  );

  return (
    <section
      ref={nodeRef}
      data-widget={item.id}
      className={s.widget}
      data-size={item.size}
      data-type={item.type}
      data-bare={def.bare ? "" : undefined}
      data-titled={showTitle ? "" : undefined}
      data-fresh={fresh ? "" : undefined}
      data-motion-gentle=""
      data-dragging={dragging ? "" : undefined}
      data-overlay={overlay ? "" : undefined}
      style={{ "--cols": size.cols, "--rows": size.rows, "--i": Math.min(index, 10) } as React.CSSProperties}
      aria-label={label}
    >
      {editing && (
        <div className={s.chrome}>
          <button type="button" className={s.handle} ref={handleRef} {...handleProps} data-handle="" aria-label={`Move ${label}. Use the arrow keys after picking it up.`}>
            <DragHandGesture />
            <span>{label}</span>
          </button>
          {def.sizes.length > 1 && (
            <Menu
              trigger={
                <button type="button" className={`${s.sizeBtn} ${s.sizeOne}`} aria-label={`Size: ${sizeLabel(def, item.size)}. Change size`} title="Change size">
                  <SizeGlyph size={item.size} />
                </button>
              }
              items={sizeItems}
            />
          )}
          <Menu
            trigger={
              <IconButton label={`${label} options`} size="sm" className={s.chromeBtn}>
                <MoreHoriz />
              </IconButton>
            }
            items={[
              { label: "Move earlier", icon: <ArrowLeft />, disabled: first, onSelect: () => onMove?.(-1) },
              { label: "Move later", icon: <ArrowRight />, disabled: last, onSelect: () => onMove?.(1) },
              "separator",
              ...extra,
              ...(def.Settings ? ([{ label: "Settings…", icon: <Settings />, onSelect: () => onSettings?.() }] as MenuEntry[]) : []),
              { label: `Unpin ${label}`, icon: <PinSlash />, danger: true, onSelect: () => onUnpin?.() },
            ]}
          />
        </div>
      )}
      {showTitle && <h2 className={s.widgetTitle}>{title}</h2>}
      {editing || overlay ? body : <ContextMenu items={contextMenu}>{body}</ContextMenu>}
      {!editing && !overlay && (
        <div className={s.placeMenu}>
          <Menu
            trigger={
              <IconButton label={`${label}: options`} size="sm" variant="secondary" className={s.placeBtn} tooltip={false}>
                <MoreHoriz />
              </IconButton>
            }
            items={baseMenu}
          />
        </div>
      )}
    </section>
  );
});
