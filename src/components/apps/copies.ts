import type { AppSummary } from "@/server/docker/apps";
import type { ConfirmOptions } from "@/components/ui/Dialog";
import { sourceName } from "@/lib/app-names";
import { plural } from "@/lib/format";

/** "Remove the old copy": Compose `down` on its own project. Its folders and data stay on disk. */
export function removeCopyConfirm(a: AppSummary, of: AppSummary | undefined, onConfirm: () => Promise<void>): ConfirmOptions {
  const from = sourceName(a.source);
  const other = of ? `${of.name} from ${sourceName(of.source)}` : a.copyOf ? `${a.copyOf.name} from ${sourceName(a.copyOf.source)}` : null;
  const n = a.containers.length;
  return {
    title: `Remove the old ${a.name} from ${from}?`,
    consequences: [
      `${a.line === "stopped" ? "Deletes" : "Stops and deletes"} its ${plural(n, "container")}${other ? `. ${other} isn't touched` : ""}.`,
      "Its folders and data stay where they are on disk, so you can still copy anything out of them.",
      ...(a.routes.some((r) => r.enabled) ? [`${a.routes.filter((r) => r.enabled).map((r) => r.url.replace(/^https?:\/\//, "")).join(", ")} will show an error until you point it at another app.`] : []),
      ...(a.source === "casaos" ? ["CasaOS may still list it. Uninstall it in CasaOS to clear it from there too."] : []),
    ],
    confirmLabel: a.line === "stopped" ? "Remove containers" : "Stop and remove",
    variant: "danger",
    onConfirm,
  };
}

/** "Stop the old copy": for a copy Gluon can only manage container by container. */
export function stopCopyConfirm(a: AppSummary, of: AppSummary | undefined, onConfirm: () => Promise<void>): ConfirmOptions {
  const ports = [...new Set(a.containers.flatMap((c) => c.ports.map((p) => p.host)))];
  return {
    title: `Stop the old ${a.name} from ${sourceName(a.source)}?`,
    consequences: [
      ports.length ? `Anything still using port${ports.length > 1 ? "s" : ""} ${ports.join(", ")} stops working.` : "It stops using memory and CPU.",
      ...(of ? [`${of.name} from ${sourceName(of.source)} keeps running.`] : []),
      "You can start it again from its page.",
    ],
    confirmLabel: "Stop it",
    variant: "primary",
    onConfirm,
  };
}

/** Uninstalling an app Umbrel installed: Umbrel removes it along with its data. Works for old copies too. */
export function uninstallUmbrelConfirm(a: AppSummary, of: AppSummary | undefined, onConfirm: () => Promise<void>): ConfirmOptions {
  const other = of ? `${of.name} from ${sourceName(of.source)}` : a.copyOf ? `${a.copyOf.name} from ${sourceName(a.copyOf.source)}` : null;
  return {
    title: a.copyOf ? `Uninstall the old ${a.name} from Umbrel?` : `Uninstall ${a.name}?`,
    consequences: [
      "Umbrel removes the app and deletes everything it stored in its folder. This can't be undone.",
      ...(other ? [`${other} has its own copy of the data and isn't touched.`] : []),
      ...(!a.copyOf && a.routes.some((r) => r.enabled) ? ["Its public address will show an error until you remove or change it."] : []),
      ...(!a.copyOf && a.household ? ["Household members lose it from their apps."] : []),
    ],
    typeToConfirm: a.name,
    confirmLabel: "Uninstall",
    onConfirm,
  };
}
