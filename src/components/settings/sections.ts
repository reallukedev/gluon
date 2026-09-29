export interface SettingsSection {
  id: string;
  label: string;
  /** Short line in the settings list. */
  hint: string;
  /** Sentence under the section title when there's no live state to state. */
  summary: string;
  group: "You" | "Watch" | "Server";
  admin?: boolean;
  /** The section states its own live summary (and actions) through SectionHeader. */
  ownHeader?: boolean;
  /** Tables and timelines: the section may use the full width beside the list. */
  wide?: boolean;
}

/** The settings list's groups, in order. "Keep watch" is admins only (every section in it is). */
export const GROUPS: { id: SettingsSection["group"]; label: string }[] = [
  { id: "You", label: "Just for you" },
  { id: "Watch", label: "Keep watch" },
  { id: "Server", label: "Whole server" },
];

export const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", hint: "Theme, colours, text size, motion", summary: "How Gluon looks on your devices.", group: "You" },
  { id: "home", label: "Home page", hint: "Search engine, greeting, links", summary: "Your start page.", group: "You" },
  { id: "navigation", label: "Sidebar & shortcuts", hint: "Order, hide, keyboard", summary: "The pages in your sidebar and the keys that reach them.", group: "You" },
  { id: "formats", label: "Clock, dates & units", hint: "12/24 h, GB or GiB, °C or °F", summary: "How times, dates and numbers are written for you.", group: "You" },
  { id: "notifications", label: "Notifications", hint: "Where and when you're told", summary: "Where Gluon reaches you, about what, and when to stay quiet.", group: "You" },
  { id: "security", label: "Security", hint: "Password, two-step, devices", summary: "Your password, two-step verification and signed-in devices.", group: "You" },
  { id: "alerts", label: "Alerts", hint: "Monitors, channels, past problems", summary: "What Gluon watches, where it tells you, and what went wrong before.", group: "Watch", admin: true, ownHeader: true, wide: true },
  { id: "activity", label: "Activity", hint: "Who changed what, and when", summary: "Everything people changed and everything the server noticed.", group: "Watch", admin: true, ownHeader: true, wide: true },
  { id: "people", label: "People", hint: "Accounts, access, reports, invites", summary: "Everyone who can sign in, and what they can open.", group: "Watch", admin: true, ownHeader: true, wide: true },
  { id: "server", label: "Server", hint: "Umbrel or CasaOS, networks, sign-in", summary: "Settings for the whole server and everyone on it.", group: "Server", admin: true },
  { id: "integrations", label: "Connected apps", hint: "API keys for app widgets", summary: "Keys that let home page widgets read from your apps.", group: "Server", admin: true },
  { id: "updates", label: "Updates", hint: "New versions, automatic updates", summary: "Keeping Gluon itself up to date.", group: "Server", admin: true },
  { id: "about", label: "About Gluon", hint: "Version, data and backups", summary: "What's running and where its data lives.", group: "Server", admin: true },
];
