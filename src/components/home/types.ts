import type * as React from "react";
import type { MenuEntry } from "@/components/ui/Menu";
import type { Size, WidgetItem } from "@/lib/home";
import type { IntegrationKind } from "@/lib/widgets-types";

export interface WidgetProps<C = Record<string, unknown>> {
  item: WidgetItem & { config: C };
  size: Size;
  editing: boolean;
  /** Persist a config change (e.g. notes text) without opening settings. */
  update: (config: Partial<C>) => void;
  /** Open this widget's settings (for empty states whose one action is "set me up"). Absent when there are none. */
  openSettings?: () => void;
}

export interface SettingsProps<C = Record<string, unknown>> {
  config: C;
  onChange: (config: C) => void;
}

export interface WidgetDef<C = Record<string, unknown>> {
  type: string;
  name: string;
  description: string;
  category: "For you" | "Household" | "Apps" | "Server" | "Media & services";
  sizes: Size[];
  defaultSize: Size;
  defaultConfig: C;
  adminOnly?: boolean;
  /** What edit mode calls this widget when it has no title (e.g. "Jellyfin tile"). */
  label?: (config: C) => string | null;
  /** Panel title shown above the widget (omit for headerless widgets like the clock). */
  title?: (config: C) => string | null;
  Component: React.ComponentType<WidgetProps<C>>;
  Settings?: React.ComponentType<SettingsProps<C>>;
  /**
   * Runs when the settings dialog saves, before the layout is stored: for settings that live on the server rather
   * than in the layout (e.g. the guest network). Return the config to keep in the layout; throw to keep the dialog
   * open (the error message is shown).
   */
  beforeSave?: (config: C) => Promise<C>;
  /** Integration widgets: the kind of connected app they read from (grouped under that app in the catalog). */
  kind?: IntegrationKind;
  /** One widget per installed app (the App tile): the catalog offers it under each app, not in a category. */
  perApp?: boolean;
  /** Small static preview for the Collection. */
  preview: React.ReactNode;
  /** No panel around it (the greeting, the search bar, the apps block): the content is the whole item. */
  bare?: boolean;
  /** Height follows the content (rows are measured), for blocks like the pinned apps. */
  autoHeight?: boolean;
  /** Can sit on Home more than once (a link, a note, weather for two places). */
  multiple?: boolean;
  /** Not offered as a widget in the Collection: it has its own section there (apps, folders). */
  hidden?: boolean;
  /** Open its settings straight after pinning, because it's empty until set up (a link, a place). */
  setupOnPin?: boolean;
  /** Extra entries for its in-place menu (e.g. the apps block's look and icon size). */
  menu?: (config: C, update: (patch: Partial<C>) => void) => MenuEntry[];
  /** Names for its sizes when the general ones don't fit (app cards: Icon, Row, Card, Wide). */
  sizeLabels?: Partial<Record<Size, string>>;
  /** Words for the Collection's search besides the name and description. */
  keywords?: string;
}
