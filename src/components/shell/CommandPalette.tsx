"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Search, NavArrowRight, OpenNewWindow, Xmark } from "iconoir-react";
import type { NavItem } from "@/lib/nav";
import { api, useApi } from "@/lib/client/api";
import { prepare } from "@/lib/search-match";
import type { SearchAction, SearchScope } from "@/lib/search-types";
import { usePrefs } from "@/components/PrefsProvider";
import { useMediaQuery } from "@/lib/client/motion";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import type { Pin } from "@/server/pins";
import { announce, buildSections, CLEAR_RECENT, flatten, type PaletteItem, type Section } from "./paletteModel";
import { staticGroups } from "./paletteStatic";
import { usePaletteSearch, useRecentSearches } from "./usePaletteSearch";
import { PaletteIcon } from "./PaletteIcon";
import { terminalItems } from "./paletteTerminal";
import s from "./palette.module.css";


const FALLBACK_SCOPES: SearchScope[] = [{ id: "all", label: "Everything", kind: "all" }];

function placeholderFor(sc: SearchScope | undefined, admin: boolean): string {
  if (!sc || sc.kind === "all") return admin ? "Search apps, files, settings and more…" : "Search your apps, files and settings…";
  if (sc.kind === "apps") return admin ? "Search apps and containers…" : "Search your apps…";
  if (sc.kind === "files") return "Search files and folders by name…";
  return `Search inside ${sc.label}…`;
}

function tipFor(sc: SearchScope | undefined, admin: boolean): string {
  if (!sc || sc.kind === "all") return admin ? "Try part of a name, a folder, or a word like “password”, “restart” or “disk”." : "Try part of an app’s name, a folder, or a word like “password” or “dark”.";
  if (sc.kind === "apps") return "Try part of the app’s name, or one of its containers.";
  if (sc.kind === "files") return "Files are found by name. Try a shorter part of it.";
  return `Try other words, or look everywhere instead.`;
}

/** ⌘ on Apple devices, Ctrl elsewhere. Only read once the palette is open (never during SSR). */
function modLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
}

export function CommandPalette({ open, onOpenChange, nav, pins }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavItem[]; pins: Pin[] }) {
  const router = useRouter();
  const { viewer, prefs, setPrefs } = usePrefs();
  const admin = viewer.role === "admin";
  const [q, setQ] = React.useState("");
  const [scope, setScope] = React.useState("all");
  /** The highlighted result, by id, so it stays put while groups stream in. null = the first one. */
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [scopeNote, setScopeNote] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const [confirm, confirmNode] = useConfirm();
  const { recent, remember, clear: clearRecent } = useRecentSearches(viewer.id);

  const scopesRes = useApi<{ scopes: SearchScope[] }>(open ? "/api/search/scopes" : null, { revalidateOnFocus: false, dedupingInterval: 30_000 });
  const scopes = scopesRes.data?.scopes ?? FALLBACK_SCOPES;
  const current = scopes.find((x) => x.id === scope) ?? scopes[0];

  React.useEffect(() => {
    if (open) {
      setQ("");
      setScope("all");
      setActiveId(null);
      setScopeNote("");
    }
  }, [open]);

  const stream = usePaletteSearch(open, q, scope);

  const signOut = React.useCallback(async () => {
    await api.post("/api/auth/logout");
    router.replace("/login");
    router.refresh();
  }, [router]);
  // The theme on screen: "system" follows the device, so offer the opposite of what it shows now.
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark);
  const statics = React.useMemo(
    () => staticGroups({ nav, pins, role: viewer.role, dark, setTheme: (d) => setPrefs({ theme: d ? "dark" : "light" }), signOut }),
    [nav, pins, viewer.role, dark, setPrefs, signOut],
  );

  const query = React.useMemo(() => prepare(q), [q]);
  const sections = React.useMemo(() => {
    const list = buildSections({ query, scope, statics, stream, recent, perGroup: scope === "all" ? 5 : 10 });
    const searching = !!query.folded && (!stream ? query.compact.length >= 2 : !stream.done);
    const empty = !!query.folded && !searching && !flatten(list).length && !list.some((x) => x.loading);
    // Something that reads like a command: offer to run it (first when it clearly is one).
    if (admin && scope === "all") {
      const run = terminalItems(q, viewer.id, router);
      if (run) {
        const at = run.strong ? 0 : list.length;
        list.splice(at, 0, { key: "terminal", name: "Terminal", tier: "local", items: run.items });
      }
    }
    // Nothing here: offer to look everywhere instead.
    if (empty && scope !== "all") list.push({ key: "widen", name: "", tier: "local", items: [{ id: "widen", label: `Search everything for “${q.trim()}”`, icon: "search" }] });
    return list;
  }, [query, scope, statics, stream, recent, q, admin, viewer.id, router]);
  const flat = React.useMemo(() => flatten(sections), [sections]);
  const found = activeId ? flat.findIndex((it) => it.id === activeId) : -1;
  const activeIndex = found >= 0 ? found : 0;
  const active = flat[activeIndex];

  const searching = !!query.folded && (stream ? !stream.done : query.compact.length >= 2);
  const nothing = !!query.folded && !searching && !flat.some((it) => it.id !== "widen") && !sections.some((x) => x.loading || x.error);

  // Only when the highlight moves to another result, not every time a group streams in.
  const activeKey = active?.id;
  React.useEffect(() => {
    if (!activeKey) return;
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  function setScopeTo(id: string) {
    const next = scopes.find((x) => x.id === id);
    if (!next) return;
    setScope(id);
    setActiveId(null);
    setScopeNote(next.kind === "all" ? "Searching everywhere" : `Searching in ${next.label}`);
    inputRef.current?.focus();
  }

  function cycleScope(dir: 1 | -1) {
    if (scopes.length < 2) return;
    const i = Math.max(0, scopes.findIndex((x) => x.id === scope));
    setScopeTo(scopes[(i + dir + scopes.length) % scopes.length]!.id);
  }

  function run(a: SearchAction) {
    const post = () => api.post<{ ok?: boolean; message?: string }>(a.url, a.body ?? {});
    if (a.confirm) {
      const c = a.confirm;
      // After the palette has closed and handed focus back, so the question gets it.
      setTimeout(
        () =>
          confirm({
            title: c.title,
            description: c.description,
            consequences: c.consequences,
            confirmLabel: c.confirmLabel,
            typeToConfirm: c.typeToConfirm,
            variant: c.danger ? "dangerSolid" : "primary",
            onConfirm: async () => {
              const r = await post();
              toast.success(r?.message ?? a.done ?? "Done.");
            },
          }),
        0,
      );
      return;
    }
    const t = toast.loading(a.pending);
    post().then(
      (r) => toast.update(t, "success", { title: r?.message ?? a.done ?? "Done." }),
      (e: unknown) => toast.update(t, "error", { title: a.failed, description: e instanceof Error ? e.message : undefined }),
    );
  }

  function choose(it: PaletteItem | undefined, newTab = false) {
    if (!it) return;
    if (it.id === "widen") return setScopeTo("all");
    if (it.id === CLEAR_RECENT) {
      clearRecent();
      setActiveId(null);
      return;
    }
    if (it.fill !== undefined) {
      setQ(it.fill);
      setActiveId(null);
      inputRef.current?.focus();
      return;
    }
    if (query.compact.length >= 2) remember(q);
    onOpenChange(false);
    if (it.action) return run(it.action);
    if (it.run) return void it.run();
    if (!it.href) return;
    if (newTab || it.external) window.open(it.href, "_blank", "noopener,noreferrer");
    else router.push(it.href);
  }

  /** First result of the next (or previous) group, for ⌥↓ / ⌥↑. */
  function jumpGroup(dir: 1 | -1) {
    const starts: number[] = [];
    let n = 0;
    for (const sec of sections) {
      if (sec.items.length) starts.push(n);
      n += sec.items.length;
    }
    if (!starts.length) return;
    const cur = starts.filter((x) => x <= activeIndex).length - 1;
    const next = starts[(cur + dir + starts.length) % starts.length]!;
    setActiveId(flat[next]?.id ?? null);
  }

  function move(to: number) {
    if (!flat.length) return;
    setActiveId(flat[(to + flat.length) % flat.length]!.id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey) jumpGroup(dir);
      else move(activeIndex + dir);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      move(Math.min(flat.length - 1, Math.max(0, activeIndex + (e.key === "PageDown" ? 8 : -8))));
    } else if ((e.key === "Home" || e.key === "End") && !q) {
      e.preventDefault();
      move(e.key === "Home" ? 0 : flat.length - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === "Backspace" && !q && scope !== "all") {
      e.preventDefault();
      setScopeTo("all");
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active, e.metaKey || e.ctrlKey);
    }
  }

  // Rows are memoised; hand them a callback that never changes but always runs the latest `choose`.
  const chooseRef = React.useRef(choose);
  chooseRef.current = choose;
  const onChoose = React.useCallback((it: PaletteItem, newTab?: boolean) => chooseRef.current(it, newTab), []);

  const mod = open ? modLabel() : "Ctrl";
  const live = scopeNote && !q ? scopeNote : announce(sections, stream, q.trim());
  let index = -1;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
        <Dialog.Portal>
          <Dialog.Backdrop className={s.backdrop} />
          <Dialog.Popup className={s.popup} initialFocus={inputRef} aria-label="Search">
            <div className={s.inputRow}>
              <Search className={s.searchIcon} aria-hidden />
              <input
                ref={inputRef}
                className={s.input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActiveId(null);
                  setScopeNote("");
                }}
                onKeyDown={onKeyDown}
                placeholder={placeholderFor(current, admin)}
                role="combobox"
                aria-expanded={flat.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-label={placeholderFor(current, admin).replace(/…$/, "")}
                aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
                aria-keyshortcuts="Tab Shift+Tab"
                enterKeyHint="go"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={200}
              />
              {q && (
                <button
                  type="button"
                  className={s.clear}
                  aria-label="Clear search"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQ("");
                    setActiveId(null);
                    inputRef.current?.focus();
                  }}
                >
                  <Xmark />
                </button>
              )}
              <kbd className={s.esc} aria-hidden>
                esc
              </kbd>
              <Dialog.Close className={s.cancel}>Cancel</Dialog.Close>
            </div>

            {scopes.length > 1 && (
              <div className={s.scopes} role="tablist" aria-label="Where to search">
                {scopes.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    role="tab"
                    tabIndex={-1}
                    aria-selected={sc.id === scope}
                    aria-controls={listId}
                    className={s.scope}
                    title={sc.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setScopeTo(sc.id)}
                  >
                    {sc.label}
                  </button>
                ))}
              </div>
            )}

            <div className={s.list} ref={listRef} role="listbox" id={listId} aria-label="Results">
              {stream?.error && (
                <p className={s.searchError}>
                  <span className={s.failMark} aria-hidden />
                  {stream.error}
                </p>
              )}
              {sections.map((sec) => {
                const headId = `${listId}-g-${sec.key}`;
                return (
                  <div key={sec.key} role="group" aria-labelledby={sec.name ? headId : undefined} className={s.group}>
                    {sec.name && <GroupHead id={headId} sec={sec} />}
                    {sec.items.map((it) => {
                      index++;
                      const i = index;
                      return (
                        <Option
                          key={it.id}
                          id={`${listId}-${i}`}
                          item={it}
                          selected={i === activeIndex}
                          fromApp={sec.tier === "app"}
                          onHover={setActiveId}
                          onChoose={onChoose}
                        />
                      );
                    })}
                    {sec.loading && !sec.items.length && <SkeletonRows />}
                  </div>
                );
              })}
              {searching && !flat.length && !sections.some((x) => x.loading) && <p className={s.searching}>Searching {current && current.kind !== "all" ? `in ${current.label}` : "everywhere"}…</p>}
              {nothing && (
                <div className={s.empty}>
                  <p className={s.emptyTitle}>Nothing matches “{q.trim()}”{current && current.kind !== "all" ? ` in ${current.label}` : ""}</p>
                  <p>{tipFor(current, admin)}</p>
                </div>
              )}
            </div>

            <div className={s.status} role="status" aria-live="polite" aria-atomic="true">
              {live}
            </div>

            <div className={s.foot} aria-hidden>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
              <span>
                <kbd>{mod}</kbd>
                <kbd>↵</kbd> new tab
              </span>
              {scopes.length > 1 && (
                <span>
                  <kbd>tab</kbd> where to search
                </span>
              )}
              {prefs.shortcuts && nav.length > 1 && (
                <span className={s.footJump}>
                  <kbd>g</kbd> then a letter jumps
                </span>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {confirmNode}
    </>
  );
}

function GroupHead({ id, sec }: { id: string; sec: Section }) {
  return (
    <div className={s.groupHead}>
      <span id={id} className={`label ${s.groupLabel}`} title={sec.name}>
        {sec.name}
      </span>
      {sec.error ? (
        <span className={s.groupFail} title={sec.error}>
          <span className={s.failMark} aria-hidden />
          {sec.error}
        </span>
      ) : sec.loading ? (
        <span className={s.groupMeta}>{sec.items.length ? "Updating…" : "Searching…"}</span>
      ) : null}
    </div>
  );
}

const Option = React.memo(function Option({
  id,
  item: it,
  selected,
  fromApp,
  onHover,
  onChoose,
}: {
  id: string;
  item: PaletteItem;
  selected: boolean;
  fromApp: boolean;
  onHover: (id: string) => void;
  onChoose: (it: PaletteItem, newTab?: boolean) => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-id={it.id}
      className={s.option}
      onMouseMove={() => !selected && onHover(it.id)}
      onClick={(e) => onChoose(it, e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && it.href && onChoose(it, true)}
    >
      <PaletteIcon icon={it.icon} image={it.image} label={it.label} fromApp={fromApp} />
      <span className={s.optText}>
        <span className={s.optLabel} title={it.label}>
          {it.label}
        </span>
        {(it.hint || it.at) && (
          <span className={s.optHint} title={it.hint}>
            {it.hint}
            {it.hint && it.at ? " · " : ""}
            {it.at ? <Time ts={it.at} className="num" /> : null}
          </span>
        )}
      </span>
      {it.external ? <OpenNewWindow className={s.optExt} aria-label="Opens in a new tab" /> : it.href ? <NavArrowRight className={s.optGo} aria-hidden /> : null}
    </div>
  );
});

/** Two rows shaped like results while a connected app is being asked. Still, on purpose. */
function SkeletonRows() {
  return (
    <div className={s.skeletons} aria-hidden>
      {[0.46, 0.32].map((w) => (
        <div key={w} className={s.skeletonRow}>
          <span className={s.skeletonTile} />
          <span className={s.skeletonBar} style={{ width: `${w * 100}%` }} />
        </div>
      ))}
    </div>
  );
}
