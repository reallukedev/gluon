import type * as React from "react";
import type { MenuEntry } from "@/components/ui/Menu";
import type { Size, WidgetItem } from "@/lib/home";
import type { IntegrationKind } from "@/lib/widgets-types";

export interface WidgetProps<C = Record<string, unknown>> {
  item: WidgetItem & { config: C };
  size: Size;
  editing: boolean;
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
  label?: (config: C) => string | null;
  title?: (config: C) => string | null;
  Component: React.ComponentType<WidgetProps<C>>;
  Settings?: React.ComponentType<SettingsProps<C>>;
  /**
   * Runs when the settings dialog saves, before the layout is stored: for settings that live on the server rather
   * than in the layout (e.g. the guest network). Return the config to keep in the layout; throw to keep the dialog
   * open (the error message is shown).
   */
  beforeSave?: (config: C) => Promise<C>;
  kind?: IntegrationKind;
  /** One widget per installed app (the App tile): the catalog offers it under each app, not in a category. */
  perApp?: boolean;
  preview: React.ReactNode;
  bare?: boolean;
  autoHeight?: boolean;
  multiple?: boolean;
  hidden?: boolean;
  /** Open its settings straight after pinning, because it's empty until set up (a link, a place). */
  setupOnPin?: boolean;
  menu?: (config: C, update: (patch: Partial<C>) => void) => MenuEntry[];
  sizeLabels?: Partial<Record<Size, string>>;
  keywords?: string;
}
