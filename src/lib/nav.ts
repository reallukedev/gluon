/** Navigation destinations. Order and visibility are customisable per user (prefs.sidebarOrder/Hidden). */
export interface NavItem {
  id: string;
  label: string;
  href: string;
  group: "main" | "watch";
  admin?: boolean;
  /** Short description for the command palette and the sidebar editor. */
  hint: string;
}

export const NAV: NavItem[] = [
  { id: "home", label: "Home", href: "/", group: "main", hint: "Your start page and widgets" },
  { id: "status", label: "Status", href: "/status", group: "main", hint: "Is everything working?" },
  { id: "apps", label: "Apps", href: "/apps", group: "main", admin: true, hint: "Stacks, containers, logs" },
  { id: "files", label: "Files", href: "/files", group: "main", hint: "Browse and share files" },
  { id: "network", label: "Network", href: "/network", group: "main", admin: true, hint: "Public addresses, DNS, exposure" },
  { id: "storage", label: "Storage", href: "/storage", group: "main", admin: true, hint: "Disks, mounts, space" },
  { id: "system", label: "System", href: "/system", group: "main", admin: true, hint: "Updates, services, power" },
  { id: "diagnostics", label: "Diagnostics", href: "/diagnostics", group: "main", admin: true, hint: "Checkups, live traffic, logs" },
  { id: "alerts", label: "Alerts", href: "/alerts", group: "watch", admin: true, hint: "Problems, monitors, notifications" },
  { id: "activity", label: "Activity", href: "/activity", group: "watch", admin: true, hint: "Who changed what, and when" },
  { id: "people", label: "People", href: "/people", group: "watch", admin: true, hint: "Household accounts and access" },
];

export function orderedNav(role: "admin" | "member", order: string[], hidden: string[], opts: { memberStatus: boolean; memberFiles: boolean }) {
  const allowed = NAV.filter((n) => {
    if (n.admin && role !== "admin") return false;
    if (role === "member" && n.id === "status" && !opts.memberStatus) return false;
    if (role === "member" && n.id === "files" && !opts.memberFiles) return false;
    return true;
  });
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? 1000 + NAV.findIndex((n) => n.id === id) : i;
  };
  const sorted = [...allowed].sort((a, b) => rank(a.id) - rank(b.id));
  return {
    visible: sorted.filter((n) => !hidden.includes(n.id) || n.id === "home"),
    hidden: sorted.filter((n) => hidden.includes(n.id) && n.id !== "home"),
    all: sorted,
  };
}
