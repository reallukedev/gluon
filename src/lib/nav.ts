/** Navigation destinations: one flat list. Order and visibility are customisable per user (prefs.sidebarOrder/Hidden). */
export interface NavItem {
  id: string;
  label: string;
  href: string;
  admin?: boolean;
  /** Short description for the command palette and the sidebar editor. */
  hint: string;
  /** What the page is to a household member, when it differs. */
  memberHint?: string;
  /** Second key of the "g then a letter" jump (see Shell). */
  key: string;
}

export const NAV: NavItem[] = [
  { id: "home", label: "Home", href: "/", hint: "Your start page and widgets", key: "h" },
  { id: "status", label: "Status", href: "/status", hint: "What needs you, and the machine right now", memberHint: "Is everything working?", key: "s" },
  { id: "apps", label: "Apps", href: "/apps", admin: true, hint: "Apps, the app store, Docker", key: "a" },
  { id: "files", label: "Files", href: "/files", hint: "Browse and share files", key: "f" },
  { id: "storage", label: "Storage", href: "/storage", admin: true, hint: "Disks, mounts, space", key: "d" },
  { id: "network", label: "Network", href: "/network", admin: true, hint: "Public addresses, DNS, exposure", key: "n" },
  { id: "system", label: "System", href: "/system", admin: true, hint: "Updates, services, sign-ins, power", key: "y" },
  { id: "diagnostics", label: "Diagnostics", href: "/diagnostics", admin: true, hint: "Checkups, live traffic, logs", key: "x" },
  { id: "terminal", label: "Terminal", href: "/terminal", admin: true, hint: "Run commands on the server and in containers", key: "t" },
];

/** Settings lives in the account menu, not the list, but has a jump key too. */
export const SETTINGS_KEY = "c";

/** "Keep watch" lives in Settings (admins), with jump keys of its own. */
export const SETTINGS_JUMPS: { key: string; label: string; href: string }[] = [
  { key: "l", label: "Alerts", href: "/settings/alerts" },
  { key: "v", label: "Activity", href: "/settings/activity" },
  { key: "p", label: "People", href: "/settings/people" },
];

/** The hint for this person's role. */
export const hintFor = (n: NavItem, role: "admin" | "member") => (role === "member" && n.memberHint ? n.memberHint : n.hint);

/**
 * The destinations this person may see, in their order. Ids in `order`/`hidden` that aren't
 * destinations any more ("alerts", "activity", "people": now in Settings) are ignored; anything
 * not in `order` keeps its place from NAV, so an empty order is the usual order.
 */
export function orderedNav(role: "admin" | "member", order: readonly string[], hidden: readonly string[], opts: { memberStatus: boolean; memberFiles: boolean }) {
  const allowed = NAV.filter((n) => {
    if (n.admin && role !== "admin") return false;
    if (role === "member" && n.id === "status" && !opts.memberStatus) return false;
    if (role === "member" && n.id === "files" && !opts.memberFiles) return false;
    return true;
  });
  const known = order.filter((id) => NAV.some((n) => n.id === id));
  const rank = (id: string) => {
    const i = known.indexOf(id);
    return i === -1 ? 1000 + NAV.findIndex((n) => n.id === id) : i;
  };
  const sorted = [...allowed].sort((a, b) => rank(a.id) - rank(b.id));
  const isHidden = (n: NavItem) => n.id !== "home" && hidden.includes(n.id);
  return {
    visible: sorted.filter((n) => !isHidden(n)),
    hidden: sorted.filter(isHidden),
    all: sorted,
  };
}
