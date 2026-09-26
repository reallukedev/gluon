"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Drawer } from "@base-ui/react/drawer";
import { Menu as MenuIcon, Search, SidebarCollapse, SidebarExpand, LogOut, Settings, HalfMoon, SunLight, Pin, Xmark } from "iconoir-react";
import { orderedNav } from "@/lib/nav";
import { api, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { useMediaQuery } from "@/lib/client/motion";
import { NavIcon, HostMark } from "./NavIcon";
import { CommandPalette } from "./CommandPalette";
import { ReauthDialog } from "./ReauthDialog";
import { ForcePasswordChange } from "./ForcePasswordChange";
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

  const nav = orderedNav(viewer.role, prefs.sidebarOrder, prefs.sidebarHidden, { memberStatus, memberFiles });
  const collapsed = prefs.sidebarCollapsed;

  // Close the mobile drawer on navigation.
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  // Page chrome (e.g. the Status header) can ask for the palette without owning its state.
  React.useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener("gluon:palette", open);
    return () => window.removeEventListener("gluon:palette", open);
  }, []);

  // ⌘K / Ctrl+K opens the palette. "g h/s/a/f…" style chords jump to sections.
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
        const map: Record<string, string> = { h: "/", s: "/status", a: "/apps", f: "/files", n: "/network", d: "/storage", y: "/system", x: "/diagnostics", l: "/alerts", p: "/people", c: "/settings" };
        const href = map[e.key.toLowerCase()];
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
  }, [prefs.shortcuts, router]);

  const badgeFor = (id: string) => {
    if (viewer.role !== "admin") return null;
    if (id === "status" || id === "alerts") {
      const n = data.fault + data.attention;
      if (!n) return null;
      return (
        <span className={s.badge} aria-label={`${n} need you`}>
          <i className={s.badgeMark} data-fault={data.fault > 0 ? "" : undefined} aria-hidden />
          <span>{n}</span>
        </span>
      );
    }
    if (id === "people" && data.reports) {
      return (
        <span className={s.badge} aria-label={`${data.reports} problem reports`}>
          <i className={s.badgeMark} aria-hidden />
          <span>{data.reports}</span>
        </span>
      );
    }
    return null;
  };

  async function signOut() {
    await api.post("/api/auth/logout").catch(() => null);
    router.replace("/login");
    router.refresh();
  }

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
          {nav.visible
            .filter((n) => n.group === "main")
            .map((n) => (
              <NavLink key={n.id} href={n.href} label={n.label} id={n.id} active={isActive(pathname, n.href)} badge={badgeFor(n.id)} collapsed={collapsed && !inDrawer} />
            ))}
        </div>
        {nav.visible.some((n) => n.group === "watch") && (
          <div className={s.group}>
            <div className={`label ${s.groupLabel}`}>Keep watch</div>
            {nav.visible
              .filter((n) => n.group === "watch")
              .map((n) => (
                <NavLink key={n.id} href={n.href} label={n.label} id={n.id} active={isActive(pathname, n.href)} badge={badgeFor(n.id)} collapsed={collapsed && !inDrawer} />
              ))}
          </div>
        )}
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
            <button type="button" className={s.me} aria-label={`Account: ${viewer.displayName}`}>
              <span className={s.avatar} aria-hidden>
                {initials(viewer.displayName)}
              </span>
              <span className={s.meText}>
                <span className={s.meName}>{viewer.displayName}</span>
                <span className={s.meRole}>{viewer.role === "admin" ? "Admin" : "Household"}</span>
              </span>
            </button>
          }
          items={[
            { label: "Settings", icon: <Settings />, onSelect: () => router.push("/settings"), hint: "g c" },
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
      {viewer.mustChangePassword && <ForcePasswordChange />}
    </div>
  );
}

function NavLink({
  href,
  label,
  id,
  active,
  badge,
  collapsed,
  external,
}: {
  href: string;
  label: string;
  id: string;
  active: boolean;
  badge?: React.ReactNode;
  collapsed: boolean;
  external?: boolean;
}) {
  const link = (
    <Link
      href={href}
      className={s.link}
      aria-current={active ? "page" : undefined}
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
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
