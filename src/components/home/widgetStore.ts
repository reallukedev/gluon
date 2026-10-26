import type { WidgetDef } from "./types";

/** Registry for integration widgets (kept separate from registry.tsx to avoid an import cycle). */
export const extraWidgets: WidgetDef[] = [];

export function registerWidget<C>(d: WidgetDef<C>) {
  const def = d as unknown as WidgetDef;
  // Replace rather than skip, so a hot reload doesn't keep rendering the stale copy.
  const at = extraWidgets.findIndex((x) => x.type === def.type);
  if (at === -1) extraWidgets.push(def);
  else extraWidgets[at] = def;
}
