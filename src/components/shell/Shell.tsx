"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Drawer } from "@base-ui/react/drawer";
import { Menu as MenuIcon, Search, SidebarCollapse, SidebarExpand, LogOut, Settings, HalfMoon, SunLight, Pin, Xmark, ChatBubbleWarning } from "iconoir-react";
import { orderedNav, SETTINGS_JUMPS, SETTINGS_KEY } from "@/lib/nav";
import { api, useApi } from "@/lib/client/api";
import { peopleHref } from "@/lib/settings-links";
import { usePrefs } from "@/components/PrefsProvider";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { useMediaQuery } from "@/lib/client/motion";
import { NavIcon, HostMark } from "./NavIcon";
import { CommandPalette } from "./CommandPalette";
import { ReauthDialog } from "./ReauthDialog";
import { ForcePasswordChange } from "./ForcePasswordChange";
import { ForceMfaSetup } from "./ForceMfaSetup";
import type { Pin as PinT } from "@/server/pins";
import s from "./shell.module.css";

const UploadsElsewhere = dynamic(() => import("@/components/files/UploadsElsewhere"), { ssr: false });

interface ShellData {
  fault: number;
  attention: number;
  reports: number;
  pins: PinT[];
  announcements: { id: string; message: string; app_id: string | null }[];
}

export interface ShellProps {
  children: React.ReactNode;
  memberStatus: boolean;
  memberFiles: boolean;
  initial: ShellData;
}

/** Which pages a household member may open beyond their own (admins: all). Settings reads it to list the right pages. */
const NavAccess = React.createContext<{ memberStatus: boolean; memberFiles: boolean }>({ memberStatus: true, memberFiles: true });
export const useNavAccess = () => React.useContext(NavAccess);

const noop = () => () => {};
function useIsMac() {
  return React.useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => true,
  );
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Shell({ children, memberStatus, memberFiles, initial }: ShellProps) {
  const { prefs, viewer, serverName, setPrefs } = usePrefs();
  const pathname = usePathname();
  const search = useSearchParams();
  const here = search.size ? `${pathname}?${search.toString()}` : pathname;
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const { data = initial } = useApi<ShellData>("/api/shell", { refresh: 20_000, fallbackData: initial });

  const [dismissed, setDismissed] = React.useState<string[]>([]);
  React.useEffect(() => {
    try {
      setDismissed(JSON.parse(sessionStorage.getItem("gluon:dismissed-announcements") ?? "[]") as string[]);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      sessionStorage.setItem("gluon:dismissed-announcements", JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  const announcements = data.announcements.filter((a) => !dismissed.includes(a.id));

  const access = React.useMemo(() => ({ memberStatus, memberFiles }), [memberStatus, memberFiles]);
  const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, access);
  const collapsed = prefs.sidebarCollapsed;
  // "g" then a letter jumps to any page this person can open, shown in the sidebar or not.
  const chordKey = nav.all.map((n) => `${n.key}${n.href}`).join(" ");
  const isAdmin = viewer.role === "admin";
  const chords = React.useMemo(() => {
    const map = new Map<string, string>([[SETTINGS_KEY, "/settings"]]);
    if (isAdmin) for (const j of SETTINGS_JUMPS) map.set(j.key, j.href);
    for (const pair of chordKey.split(" ")) if (pair) map.set(pair[0]!, pair.slice(1));
    return map;
  }, [chordKey, isAdmin]);

  // Close the mobile drawer on navigation.
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  // Page chrome (e.g. the Status header) can ask for the palette without owning its state.
  React.useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener("gluon:palette", open);
    return () => window.removeEventListener("gluon:palette", open);
  }, []);

  // ⌘K / Ctrl+K opens the palette. "g h/s/a/f…" style chords jump to sections (keys in lib/nav).
  React.useEffect(() => {
    let chord: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (!prefs.shortcuts || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (chord === "g") {
        const href = chords.get(e.key.toLowerCase());
        chord = null;
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (e.key === "g") {
        chord = "g";
        clearTimeout(chordTimer);
        chordTimer = setTimeout(() => (chord = null), 900);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.shortcuts, router, chords]);

  /** The one problems count lives on Status. (Household problem reports show on the account button: they're in Settings → People.) */
  const badgeFor = (id: string): { node: React.ReactNode; text: string } | null => {
    if (viewer.role !== "admin") return null;
    if (id === "status") {
      const n = data.fault + data.attention;
      if (!n) return null;
      const text = data.fault ? `${n} need${n === 1 ? "s" : ""} you, ${data.fault} broken` : `${n} need${n === 1 ? "s" : ""} you`;
      return {
        text,
        node: (
          <span className={s.badge} role="img" aria-label={text}>
            <i className={s.badgeMark} data-fault={data.fault > 0 ? "" : undefined} aria-hidden />
            <span aria-hidden className="num">
              {n}
            </span>
          </span>
        ),
      };
    }
    return null;
  };

  async function signOut() {
    await api.post("/api/auth/logout").catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  // Household problem reports wait in Settings → People; the account button (Settings' door) carries their count.
  const reportsText = viewer.role === "admin" && data.reports ? `${data.reports} problem report${data.reports === 1 ? "" : "s"} waiting` : null;

  const isMac = useIsMac();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const effectiveDark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark);
  const railed = collapsed;

  const sidebarBody = (inDrawer: boolean) => (
    <>
      <div className={s.host}>
        <HostMark className={s.hostMark} />
        <div className={s.hostText}>
          <div className={s.hostName}>{serverName}</div>
          <div className={s.hostSub}>
            <span className={s.zoneDot} data-zone={viewer.zone} aria-hidden />
            {viewer.zone === "home" ? "At home" : "Away from home"}
          </div>
        </div>
        {!inDrawer && !railed && (
          <IconButton label="Collapse sidebar" size="sm" className={s.collapse} onClick={() => void setPrefs({ sidebarCollapsed: true })}>
            <SidebarCollapse />
          </IconButton>
        )}
      </div>
      {!inDrawer && (
        <div className={s.searchRow}>
          <Tooltip content="Search" shortcut="⌘K" side="right" disabled={!railed}>
            <button type="button" className={s.search} onClick={() => setPaletteOpen(true)} aria-label={railed ? "Search" : undefined} aria-keyshortcuts="Meta+K Control+K">
              <Search />
              <span className={s.searchText}>Search</span>
              <kbd className={s.searchKbd} aria-hidden>
                {isMac ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
          </Tooltip>
        </div>
      )}
      <nav className={s.scroll} aria-label="Main">
        <div className={s.group}>
          {nav.visible.map((n) => {
            const badge = badgeFor(n.id);
            return (
              <NavLink
                key={n.id}
                href={n.href}
                label={n.label}
                id={n.id}
                active={isActive(pathname, n.href)}
                badge={badge?.node}
                tooltip={badge ? `${n.label} · ${badge.text}` : undefined}
                collapsed={collapsed && !inDrawer}
              />
            );
          })}
        </div>
        {data.pins.length > 0 && (
          <div className={s.group}>
            <div className={`label ${s.groupLabel}`}>Pinned</div>
            {data.pins.map((p) => {
              const href = p.kind === "folder" ? `/files?path=${encodeURIComponent(p.target)}` : p.kind === "app" ? `/apps/${encodeURIComponent(p.target)}` : p.target;
              const external = p.kind === "link";
              return (
                <NavLink
                  key={p.id}
                  href={href}
                  label={p.label}
                  id={p.kind === "folder" ? "folder" : p.kind === "app" ? "app" : p.kind === "link" ? "link" : "home"}
                  active={!external && here === href}
                  collapsed={collapsed && !inDrawer}
                  external={external}
                />
              );
            })}
          </div>
        )}
      </nav>
      <div className={s.foot}>
        <Menu
          side="top"
          align="start"
          trigger={
            <button type="button" className={s.me} aria-label={`Account: ${viewer.displayName}${reportsText ? `. ${reportsText}` : ""}`}>
              <span className={s.avatar} aria-hidden>
                {initials(viewer.displayName)}
              </span>
              <span className={s.meText}>
                <span className={s.meName}>{viewer.displayName}</span>
                <span className={s.meRole}>{viewer.role === "admin" ? "Admin" : "Household"}</span>
              </span>
              {reportsText && (
                <span className={s.badge} aria-hidden title={reportsText}>
                  <i className={s.badgeMark} />
                  <span className="num">{data.reports}</span>
                </span>
              )}
            </button>
          }
          items={[
            ...(reportsText ? [{ label: reportsText, description: "Settings → People → Problem reports", icon: <ChatBubbleWarning />, onSelect: () => router.push(peopleHref({ tab: "reports" })) }, "separator" as const] : []),
            { label: "Settings", icon: <Settings />, onSelect: () => router.push("/settings"), hint: prefs.shortcuts ? `g ${SETTINGS_KEY}` : undefined },
            {
              label: effectiveDark ? "Use light theme" : "Use dark theme",
              icon: effectiveDark ? <SunLight /> : <HalfMoon />,
              onSelect: () => void setPrefs({ theme: effectiveDark ? "light" : "dark" }),
            },
            ...(prefs.theme !== "system" ? [{ label: "Match my device's theme", onSelect: () => void setPrefs({ theme: "system" }) }] : []),
            "separator",
            { label: "Sign out", icon: <LogOut />, onSelect: () => void signOut() },
          ]}
        />
        {railed && !inDrawer && (
          <IconButton label="Expand sidebar" size="sm" onClick={() => void setPrefs({ sidebarCollapsed: false })}>
            <SidebarExpand />
          </IconButton>
        )}
      </div>
    </>
  );

  return (
    <NavAccess.Provider value={access}>
    <div className={s.frame} data-collapsed={collapsed ? "" : undefined}>
      <a href="#main" className={s.skip}>
        Skip to content
      </a>
      <aside className={s.sidebar}>{sidebarBody(false)}</aside>

      <div className={s.main}>
        <header className={s.topbar}>
          <Drawer.Root open={drawerOpen} onOpenChange={setDrawerOpen} swipeDirection="left">
            <Drawer.Trigger
              render={
                <IconButton label="Open navigation" tooltip={false}>
                  <MenuIcon />
                </IconButton>
              }
            />
            <Drawer.Portal>
              <Drawer.Backdrop className={s.drawerBackdrop} data-motion-gentle="" />
              <Drawer.Viewport className={s.drawerViewport}>
                <Drawer.Popup className={s.drawerPopup} aria-label="Navigation" data-motion-gentle="">
                  {sidebarBody(true)}
                </Drawer.Popup>
              </Drawer.Viewport>
            </Drawer.Portal>
          </Drawer.Root>
          <Link href="/" className={s.topTitle} aria-label={`${serverName}, home`}>
            <HostMark />
            <span className={s.topName}>{serverName}</span>
          </Link>
          <IconButton label="Search" tooltip={false} onClick={() => setPaletteOpen(true)}>
            <Search />
          </IconButton>
        </header>

        {announcements.map((a) => (
          <div key={a.id} className={s.announcement} role="status">
            <span className={s.announcementMark} aria-hidden />
            <span className={s.announcementText}>{a.message}</span>
            <IconButton label="Hide this message" size="sm" tooltip={false} onClick={() => dismiss(a.id)} className={s.announcementClose}>
              <Xmark />
            </IconButton>
          </div>
        ))}

        <main id="main" tabIndex={-1} className={s.content}>
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} nav={nav.all} pins={data.pins} />
      <ReauthDialog />
      {!pathname.startsWith("/files") && <UploadsElsewhere />}
      {viewer.mustChangePassword ? <ForcePasswordChange /> : viewer.mustSetUpMfa ? <ForceMfaSetup /> : null}
    </div>
    </NavAccess.Provider>
  );
}

function NavLink({
  href,
  label,
  id,
  active,
  badge,
  tooltip,
  collapsed,
  external,
}: {
  href: string;
  label: string;
  id: string;
  active: boolean;
  badge?: React.ReactNode;
  /** Rail tooltip, when it should say more than the label (the count is hidden on the rail). */
  tooltip?: string;
  collapsed: boolean;
  external?: boolean;
}) {
  const link = (
    <Link
      href={href}
      className={s.link}
      aria-current={active ? "page" : undefined}
      // On the icon rail the label is hidden, so the link carries its name (and count) itself.
      aria-label={collapsed ? (tooltip ?? label) : undefined}
      prefetch={false}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {id === "pin" ? <Pin /> : <NavIcon id={id} />}
      <span className={s.linkLabel}>{label}</span>
      {badge}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={tooltip ?? label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
