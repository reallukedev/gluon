import type { useRouter } from "next/navigation";
import { lastTarget, paletteCommand, requestAutorun, terminalHref, TERMINAL_RUN_EVENT } from "@/lib/terminal/palette";
import { containerOf, type TargetId } from "@/lib/terminal/types";
import type { PaletteItem } from "./paletteModel";

/**
 * "Run `df -h` on the server" (and in the container used last) when what's typed reads like a
 * command. Choosing it opens the terminal and runs it there, in a block you can see and stop.
 */
export function terminalItems(q: string, userId: string, router: ReturnType<typeof useRouter>): { strong: boolean; items: PaletteItem[] } | null {
  const cmd = paletteCommand(q);
  if (!cmd) return null;
  const go = (target: TargetId) => () => {
    if (window.location.pathname === "/terminal") {
      window.dispatchEvent(new CustomEvent(TERMINAL_RUN_EVENT, { detail: { target, command: cmd.command } }));
      return;
    }
    requestAutorun(target, cmd.command);
    router.push(terminalHref(target, cmd.command));
  };
  const shown = cmd.command.length > 60 ? `${cmd.command.slice(0, 59)}…` : cmd.command;
  const items: PaletteItem[] = [{ id: "terminal:run:host", label: `Run “${shown}” on the server`, hint: "Opens the Terminal and runs it there", keywords: cmd.command, icon: "terminal", run: go("host") }];
  const last = lastTarget(userId);
  const name = last ? containerOf(last) : null;
  if (last && name) items.push({ id: `terminal:run:${last}`, label: `Run “${shown}” in ${name}`, hint: "The container you used last in the Terminal", keywords: cmd.command, icon: "terminal", run: go(last) });
  return { strong: cmd.strong, items };
}
