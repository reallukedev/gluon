import type { WidgetDef } from "./types";

/** Registry for integration widgets (kept separate from registry.tsx to avoid an import cycle). */
export const extraWidgets: WidgetDef[] = [];

export function registerWidget<C>(d: WidgetDef<C>) {
  const def = d as unknown as WidgetDef;
  if (!extraWidgets.some((x) => x.type === def.type)) extraWidgets.push(def);
}
