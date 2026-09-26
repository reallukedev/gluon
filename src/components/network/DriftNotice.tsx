import type { DriftInfo } from "@/lib/network-types";

/** One sentence: who changed the web server's settings file, whether it matters, what saving does. */
export function driftSentence(info: DriftInfo | null): string {
  const who = info?.writer ? `${info.writer.charAt(0).toUpperCase()}${info.writer.slice(1)} rewrote` : "Something outside Gluon changed";
  const n = info?.settingLines ?? null;
  if (n === 0) return `${who} the web server's settings file, but only its comments differ from Gluon's version, so nothing works differently.`;
  const what = n === null ? "it differs from Gluon's version" : `${n === 1 ? "1 setting differs" : `${n} settings differ`} from Gluon's version`;
  return `${who} the web server's settings file and ${what}; your next save here puts Gluon's version back.`;
}

export function DriftSentence({ info }: { info: DriftInfo | null }) {
  return <>{driftSentence(info)}</>;
}
