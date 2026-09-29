"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Search, NavArrowRight } from "iconoir-react";
import { hintFor, type NavItem } from "@/lib/nav";
import { activityHref, alertsHref, peopleHref } from "@/lib/settings-links";
import { api } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { NavIcon } from "./NavIcon";
import type { Pin } from "@/server/pins";
import s from "./palette.module.css";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: string;
  keywords?: string;
  href?: string;
  external?: boolean;
  run?: () => void | Promise<void>;
}

interface RemoteResult {
  groups: { name: string; items: Omit<PaletteItem, "group" | "run">[] }[];
}

const SETTINGS: [string, string, string][] = [
  ["appearance", "Appearance", "theme dark light colour contrast text size density motion"],
  ["home", "Home page", "widgets search engine greeting layout"],
  ["navigation", "Sidebar", "order hide pin navigation shortcuts"],
  ["formats", "Clock, dates and units", "time 24 hour date bytes gib temperature fahrenheit bits"],
  ["notifications", "Notifications", "alerts ntfy pushover email push phone"],
  ["security", "Security", "password two-step 2fa totp sessions devices sign out"],
];

/**
 * Places inside a page, found by typing (they don't crowd the list before you type). Old names are
 * keywords, so "alerts" still finds monitors and channels in Settings.
 */
const SECTIONS: { id: string; parent: string; label: string; hint: string; keywords: string; href: string; icon: string }[] = [
  { id: "status:now", parent: "status", label: "Problems", hint: "Status · what needs you now", keywords: "alerts needs you open snoozed dismissed", href: "/status", icon: "status" },
  { id: "alerts:watching", parent: "settings", label: "Monitors", hint: "Settings · Alerts", keywords: "alerts uptime checks http tcp ping watching", href: alertsHref("watching"), icon: "settings" },
  { id: "alerts:notifications", parent: "settings", label: "Notification channels", hint: "Settings · Alerts", keywords: "alerts ntfy pushover email webhook discord sent log deliveries", href: alertsHref("notifications"), icon: "settings" },
  { id: "alerts:history", parent: "settings", label: "Past problems", hint: "Settings · Alerts", keywords: "alerts history cleared resolved", href: alertsHref("history"), icon: "settings" },
  { id: "people:reports", parent: "settings", label: "Problem reports", hint: "Settings · People", keywords: "household report broken reply", href: peopleHref({ tab: "reports" }), icon: "settings" },
  { id: "people:access", parent: "settings", label: "Who can open what", hint: "Settings · People", keywords: "access grants folders apps permissions share", href: peopleHref({ tab: "access" }), icon: "settings" },
  { id: "people:announcements", parent: "settings", label: "Announcements", hint: "Settings · People", keywords: "message banner household maintenance", href: peopleHref({ tab: "announcements" }), icon: "settings" },
  { id: "people:defaults", parent: "settings", label: "Home page for new members", hint: "Settings · People", keywords: "household defaults default layout widgets", href: peopleHref({ tab: "defaults" }), icon: "settings" },
  { id: "apps:store", parent: "apps", label: "App store", hint: "Apps · get new apps", keywords: "install umbrel get apps", href: "/apps/store", icon: "apps" },
  { id: "apps:custom", parent: "apps", label: "Your apps", hint: "Apps · apps you made", keywords: "make an app builder custom compose", href: "/apps/custom", icon: "apps" },
  { id: "apps:images", parent: "apps", label: "Docker images", hint: "Apps · Docker", keywords: "docker images pull prune", href: "/apps/images", icon: "apps" },
  { id: "apps:volumes", parent: "apps", label: "Docker volumes", hint: "Apps · Docker", keywords: "docker volumes", href: "/apps/volumes", icon: "apps" },
  { id: "apps:networks", parent: "apps", label: "Docker networks", hint: "Apps · Docker", keywords: "docker networks bridge", href: "/apps/networks", icon: "apps" },
  { id: "apps:disk", parent: "apps", label: "Docker disk use", hint: "Apps · Docker", keywords: "docker disk space usage cleanup prune", href: "/apps/disk", icon: "apps" },
];

function score(item: PaletteItem, q: string): number {
  if (!q) return 1;
  const hay = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) return 100 - label.length / 100;
  if (label.includes(q)) return 60;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((w) => hay.includes(w))) return 30;
  // subsequence match ("jlf" → jellyfin)
  let i = 0;
  for (const ch of label) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}

export function CommandPalette({ open, onOpenChange, nav, pins }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavItem[]; pins: Pin[] }) {
  const router = useRouter();
  const { viewer, prefs, setPrefs } = usePrefs();
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [remote, setRemote] = React.useState<{ term: string; items: PaletteItem[] }>({ term: "", items: [] });
  const [searching, setSearching] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  React.useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setRemote({ term: "", items: [] });
    }
  }, [open]);

  // Remote search (apps, containers, files, disks…) debounced.
  React.useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setRemote({ term: "", items: [] });
      setSearching(false);
      return;
    }
    const ctrl = { cancelled: false };
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<RemoteResult>(`/api/search?q=${encodeURIComponent(term)}`);
        if (!ctrl.cancelled) setRemote({ term, items: r.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.name }))) });
      } catch {
        if (!ctrl.cancelled) setRemote({ term, items: [] });
      } finally {
        if (!ctrl.cancelled) setSearching(false);
      }
    }, 140);
    return () => {
      ctrl.cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const staticItems = React.useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = nav.map((n) => ({ id: `nav:${n.id}`, group: "Go to", label: n.label, hint: hintFor(n, viewer.role), icon: n.id, href: n.href }));
    if (viewer.role === "admin") {
      for (const x of SECTIONS) if (x.parent === "settings" || nav.some((n) => n.id === x.parent)) items.push({ id: x.id, group: "Sections", label: x.label, hint: x.hint, keywords: x.keywords, icon: x.icon, href: x.href });
    }
    items.push({ id: "nav:settings", group: "Go to", label: "Settings", hint: "Your preferences", icon: "settings", href: "/settings" });
    for (const [id, label, kw] of SETTINGS) {
      items.push({ id: `settings:${id}`, group: "Settings", label, keywords: kw, icon: "settings", href: `/settings/${id}` });
    }
    if (viewer.role === "admin") {
      // Keep watch: in Settings, but places admins go often, so they're also in "Go to".
      items.push(
        { id: "nav:alerts", group: "Go to", label: "Alerts", hint: "Settings · monitors, channels, past problems", keywords: "monitors uptime notifications channels", icon: "settings", href: alertsHref() },
        { id: "nav:activity", group: "Go to", label: "Activity", hint: "Settings · who changed what, and when", keywords: "audit log timeline events history", icon: "settings", href: activityHref() },
        { id: "nav:people", group: "Go to", label: "People", hint: "Settings · accounts, access, invites", keywords: "users household members invite accounts", icon: "settings", href: peopleHref() },
      );
      items.push({ id: "settings:server", group: "Settings", label: "Server settings", keywords: "name network home public address integrations connected apps", icon: "settings", href: "/settings/server" });
    }
    for (const p of pins) {
      const href = p.kind === "folder" ? `/files?path=${encodeURIComponent(p.target)}` : p.kind === "app" ? `/apps/${encodeURIComponent(p.target)}` : p.target;
      items.push({ id: `pin:${p.id}`, group: "Pinned", label: p.label, icon: p.kind === "folder" ? "folder" : "link", href, external: p.kind === "link" });
    }
    const dark = prefs.theme === "dark";
    items.push(
      { id: "act:theme", group: "Actions", label: dark ? "Switch to light theme" : "Switch to dark theme", keywords: "appearance mode", run: () => setPrefs({ theme: dark ? "light" : "dark" }) },
      { id: "act:edit-home", group: "Actions", label: "Rearrange my home page", keywords: "widgets edit layout customise", href: "/?edit=1" },
      { id: "act:signout", group: "Actions", label: "Sign out", run: async () => {
          await api.post("/api/auth/logout");
          router.replace("/login");
          router.refresh();
        } },
    );
    return items;
  }, [nav, pins, viewer.role, prefs.theme, setPrefs, router]);

  const term = q.trim().toLowerCase();
  const results = React.useMemo(() => {
    const scored = staticItems
      .map((it) => ({ it, sc: score(it, term) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .map((x) => x.it);
    // Only show server results for what is typed now (never a previous query's).
    const fresh = remote.term.toLowerCase() === term ? remote.items : [];
    // Exact name matches from the server (an app called what you typed) go first.
    const exact = fresh.filter((it) => it.label.toLowerCase().startsWith(term));
    const others = fresh.filter((it) => !it.label.toLowerCase().startsWith(term));
    const top = scored.filter((it) => score(it, term) >= 60);
    const rest = scored.filter((it) => score(it, term) < 60);
    const combined = term ? [...top.slice(0, 6), ...exact, ...others, ...rest.slice(0, 6)] : staticItems.filter((i) => i.group !== "Settings" && i.group !== "Sections");
    // Group in first-seen order.
    const groups: { name: string; items: PaletteItem[] }[] = [];
    for (const it of combined) {
      let g = groups.find((x) => x.name === it.group);
      if (!g) groups.push((g = { name: it.group, items: [] }));
      g.items.push(it);
    }
    return groups;
  }, [staticItems, remote, term]);

  const flat = results.flatMap((g) => g.items);
  const clamped = Math.min(active, Math.max(0, flat.length - 1));

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  async function choose(it: PaletteItem | undefined) {
    if (!it) return;
    onOpenChange(false);
    if (it.run) await it.run();
    else if (it.href) {
      if (it.external) window.open(it.href, "_blank", "noopener,noreferrer");
      else router.push(it.href);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (Math.min(a, flat.length - 1) + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (Math.min(a, flat.length - 1) - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Home" && !q) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && !q) {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, Math.min(a, flat.length - 1) + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(a, flat.length - 1) - 8));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void choose(flat[clamped]);
    }
  }

  let index = -1;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className={s.backdrop} />
        <Dialog.Popup className={s.popup} initialFocus={inputRef} aria-label="Search and jump">
          <div className={s.inputRow}>
            <Search className={s.searchIcon} />
            <input
              ref={inputRef}
              className={s.input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search apps, files, settings…"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label="Search apps, files and settings"
              enterKeyHint="go"
              aria-activedescendant={flat[clamped] ? `${listId}-${clamped}` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className={s.esc} aria-hidden>
              esc
            </kbd>
          </div>
          <div className={s.list} ref={listRef} role="listbox" id={listId}>
            {flat.length === 0 &&
              (searching ? (
                <p className={s.empty}>Searching apps, files and settings…</p>
              ) : (
                <div className={s.empty}>
                  <p className={s.emptyTitle}>Nothing matches “{q.trim()}”</p>
                  <p>Try part of an app’s name, a folder, or a word like “password” or “dark”.</p>
                </div>
              ))}
            {results.map((g) => (
              <div key={g.name} role="group" aria-label={g.name}>
                <div className={`label ${s.groupLabel}`}>{g.name}</div>
                {g.items.map((it) => {
                  index++;
                  const i = index;
                  return (
                    <div
                      key={it.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === clamped}
                      data-index={i}
                      className={s.option}
                      onMouseMove={() => i !== clamped && setActive(i)}
                      onClick={() => void choose(it)}
                    >
                      <span className={s.optIcon}>
                        <NavIcon id={it.icon ?? "app"} />
                      </span>
                      <span className={s.optText}>
                        <span className={s.optLabel}>{it.label}</span>
                        {it.hint && <span className={s.optHint}>{it.hint}</span>}
                      </span>
                      <NavArrowRight className={s.optGo} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={s.status} role="status" aria-live="polite">
            {term.length >= 2 && !searching ? (flat.length ? `${flat.length} result${flat.length === 1 ? "" : "s"}` : "No results") : ""}
          </div>
          <div className={s.foot}>
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            {prefs.shortcuts && nav.length > 1 && (
              <span>
                <kbd>g</kbd> then a letter jumps:{" "}
                {nav.slice(0, 3).map((n, i) => (
                  <React.Fragment key={n.id}>
                    {i > 0 && ", "}
                    <kbd>{n.key}</kbd> {n.label.toLowerCase()}
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
