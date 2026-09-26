export interface SettingsSection {
  id: string;
  label: string;
  /** Short line in the settings list. */
  hint: string;
  /** Sentence under the section title when there's no live state to state. */
  summary: string;
  group: "You" | "Server";
  admin?: boolean;
}

export const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", hint: "Theme, colours, text size, motion", summary: "How Gluon looks on your devices.", group: "You" },
  { id: "home", label: "Home page", hint: "Search engine, greeting, links", summary: "Your start page.", group: "You" },
  { id: "navigation", label: "Sidebar & shortcuts", hint: "Order, hide, keyboard", summary: "The pages in your sidebar and the keys that reach them.", group: "You" },
  { id: "formats", label: "Clock, dates & units", hint: "12/24 h, GB or GiB, °C or °F", summary: "How times, dates and numbers are written for you.", group: "You" },
  { id: "notifications", label: "Notifications", hint: "Where and when you're told", summary: "Where Gluon reaches you, about what, and when to stay quiet.", group: "You" },
  { id: "security", label: "Security", hint: "Password, two-step, devices", summary: "Your password, two-step verification and signed-in devices.", group: "You" },
  { id: "server", label: "Server", hint: "Umbrel or CasaOS, networks, sign-in", summary: "Settings for the whole server and everyone on it.", group: "Server", admin: true },
  { id: "integrations", label: "Connected apps", hint: "API keys for app widgets", summary: "Keys that let home page widgets read from your apps.", group: "Server", admin: true },
  { id: "household", label: "Household defaults", hint: "Default home page for new members", summary: "What new household members start with.", group: "Server", admin: true },
  { id: "updates", label: "Updates", hint: "New versions, automatic updates", summary: "Keeping Gluon itself up to date.", group: "Server", admin: true },
  { id: "about", label: "About Gluon", hint: "Version, data and backups", summary: "What's running and where its data lives.", group: "Server", admin: true },
];
