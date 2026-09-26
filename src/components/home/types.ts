import type * as React from "react";
import type { Size, WidgetItem } from "@/lib/home";
import type { IntegrationKind } from "@/lib/widgets-types";

export interface WidgetProps<C = Record<string, unknown>> {
  item: WidgetItem & { config: C };
  size: Size;
  editing: boolean;
  /** Persist a config change (e.g. notes text) without opening settings. */
  update: (config: Partial<C>) => void;
}

export interface SettingsProps<C = Record<string, unknown>> {
  config: C;
  onChange: (config: C) => void;
}

export interface WidgetDef<C = Record<string, unknown>> {
  type: string;
  name: string;
  description: string;
  category: "For you" | "Apps" | "Server" | "Media & services";
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
  /** Integration widgets: the kind of connected app they read from (grouped under that app in the catalog). */
  kind?: IntegrationKind;
  /** One widget per installed app (the App tile): the catalog offers it under each app, not in a category. */
  perApp?: boolean;
  /** Small static preview for the catalog. */
  preview: React.ReactNode;
}
