"use client";
import type { ChatCapability, ChatHostSnapshot, ChatSettings } from "@/lib/chat-types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import s from "./chat.module.css";

/** What turning a capability on changes in the settings. Contact needs words, so it goes to the form. */
function patchFor(c: ChatCapability, cur: ChatSettings): Partial<ChatSettings> | null {
  switch (c.fix) {
    case "push":
      return { push: true };
    case "federation":
      return { federation: true };
    case "web":
      return { web: true };
    case "history":
      return { history: cur.history === "off" ? "1m" : cur.history };
    case "groups":
      return { groups: { ...cur.groups, on: true } };
    case "files":
      return { files: { ...cur.files, on: true } };
    case "signUp":
      // Invite links need the invite modules, which any save turns on; keep sign-up as it is.
      return { signUp: cur.signUp };
    default:
      return null;
  }
}

/**
 * What chat apps can do with this server, as a spec sheet: the line says on or off, the words say
 * what a person notices, the standards sit quietly to the side, and a gap Gluon can close has its
 * switch right there.
 */
export function Capabilities({ host, canFix, saving, onFix, onCalls }: { host: ChatHostSnapshot; canFix: boolean; saving: boolean; onFix: (patch: Partial<ChatSettings>) => void; onCalls: () => void }) {
  const on = host.capabilities.filter((c) => c.on).length;
  return (
    <Panel title="What chat apps can do" meta={<span className="num">{on} of {host.capabilities.length}</span>} flush>
      <div className={s.capsWrap}>
        <ul className={s.caps}>
          {host.capabilities.map((c) => {
            const patch = !c.on && canFix ? patchFor(c, host.settings) : null;
            // Calls need a relay installed first, so they get their own dialog.
            const calls = !c.on && canFix && c.fix === "calls";
            return (
              <li key={c.key} className={s.cap} data-off={c.on ? undefined : ""}>
                <span className={s.capMark} aria-hidden>
                  <StateLine state={c.on ? "running" : "stopped"} label={false} />
                </span>
                <span className={s.capHead}>
                  <span className={s.capLabel}>
                    {c.label}
                    <span className="sr-only">{c.on ? ": on" : ": off"}</span>
                  </span>
                  {c.specs.length > 0 && (
                    <span className={s.capSpecs} title={c.specs.join(", ")}>
                      {c.specs[0]}
                      {c.specs.length > 1 ? ` +${c.specs.length - 1}` : ""}
                    </span>
                  )}
                </span>
                <p className={s.capDetail}>{c.detail}</p>
                {calls && (
                  <span className={s.capFix}>
                    <Button size="sm" disabled={saving} onClick={onCalls}>
                      Set up calls
                    </Button>
                  </span>
                )}
                {patch && (
                  <span className={s.capFix}>
                    <Button size="sm" disabled={saving} onClick={() => onFix(patch)}>
                      {c.key === "history" ? "Keep history" : c.key === "invites" ? "Turn on invite links" : "Turn on"}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
