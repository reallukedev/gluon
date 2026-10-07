import { hintFor, type NavItem } from "@/lib/nav";
import { activityHref, alertsHref, peopleHref } from "@/lib/settings-links";
import type { Pin } from "@/server/pins";
import type { PaletteItem, StaticGroup } from "./paletteModel";

/** The palette's own entries: pages, settings, places inside pages, pins and quick actions. */

const SETTINGS: [string, string, string][] = [
  ["appearance", "Appearance", "theme dark light colour color contrast text size density motion"],
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

export interface StaticInput {
  nav: NavItem[];
  pins: Pin[];
  role: "admin" | "member";
  dark: boolean;
  setTheme: (dark: boolean) => void;
  signOut: () => Promise<void>;
}

export function staticGroups(i: StaticInput): StaticGroup[] {
  const admin = i.role === "admin";
  const go: PaletteItem[] = i.nav.map((n) => ({ id: `nav:${n.id}`, label: n.label, hint: hintFor(n, i.role), icon: n.id, href: n.href }));
  go.push({ id: "nav:settings", label: "Settings", hint: "Your preferences", icon: "settings", href: "/settings" });
  if (admin) {
    // Keep watch: in Settings, but places admins go often, so they're also in "Go to".
    go.push(
      { id: "nav:alerts", label: "Alerts", hint: "Settings · monitors, channels, past problems", keywords: "monitors uptime notifications channels", icon: "settings", href: alertsHref() },
      { id: "nav:activity", label: "Activity", hint: "Settings · who changed what, and when", keywords: "audit log timeline events history", icon: "settings", href: activityHref() },
      { id: "nav:people", label: "People", hint: "Settings · accounts, access, invites", keywords: "users household members invite accounts", icon: "settings", href: peopleHref() },
    );
  }

  const settings: PaletteItem[] = SETTINGS.map(([id, label, keywords]) => ({ id: `settings:${id}`, label, hint: "Settings", keywords, icon: "settings", href: `/settings/${id}` }));
  if (admin) settings.push({ id: "settings:server", label: "Server settings", hint: "Settings", keywords: "name network home public address integrations connected apps", icon: "settings", href: "/settings/server" });

  const sections: PaletteItem[] = admin
    ? SECTIONS.filter((x) => x.parent === "settings" || i.nav.some((n) => n.id === x.parent)).map((x) => ({ id: x.id, label: x.label, hint: x.hint, keywords: x.keywords, icon: x.icon, href: x.href }))
    : [];

  const pinned: PaletteItem[] = i.pins.map((p) => ({
    id: `pin:${p.id}`,
    label: p.label,
    hint: p.kind === "folder" ? p.target : p.kind === "link" ? p.target.replace(/^https?:\/\//, "") : undefined,
    icon: p.kind === "folder" ? "folder" : "link",
    href: p.kind === "folder" ? `/files?path=${encodeURIComponent(p.target)}` : p.kind === "app" ? `/apps/${encodeURIComponent(p.target)}` : p.target,
    external: p.kind === "link",
  }));

  const actions: PaletteItem[] = [];
  if (admin) {
    actions.push(
      {
        id: "cmd:checks.run",
        label: "Check everything now",
        hint: "Run every health check instead of waiting for the next round",
        keywords: "check run checks now refresh rescan scan health problems status",
        icon: "recheck",
        action: { url: "/api/search/action", body: { id: "checks.run" }, pending: "Checking everything…", failed: "Couldn't run the checks" },
      },
      { id: "act:checkup", label: "Run a checkup", hint: "Diagnostics · look for problems across the server", keywords: "diagnose doctor health test", icon: "diagnostics", href: "/diagnostics?start=full" },
    );
  }
  actions.push(
    { id: "act:theme", label: i.dark ? "Switch to light theme" : "Switch to dark theme", keywords: "appearance mode night day", icon: i.dark ? "light" : "dark", run: () => i.setTheme(!i.dark) },
    { id: "act:edit-home", label: "Rearrange my home page", keywords: "widgets edit layout customise customize", icon: "home", href: "/?edit=1" },
    { id: "act:signout", label: "Sign out", keywords: "log out logout leave", icon: "signout", run: i.signOut },
  );

  return [
    { key: "actions", name: "Actions", priority: 2, items: actions, idle: true },
    { key: "nav", name: "Go to", priority: 16, items: go, idle: true },
    { key: "settings", name: "Settings", priority: 18, items: settings },
    { key: "sections", name: "Sections", priority: 19, items: sections },
    { key: "pinned", name: "Pinned", priority: 75, items: pinned, idle: true },
  ];
}
