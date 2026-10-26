"use client";
import * as React from "react";
import { Popover } from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { CopyButton } from "@/components/ui/CopyButton";
import { useFormat } from "@/components/PrefsProvider";
import { formatBytes, plural } from "@/lib/format";
import type { SiteDetail, SiteVersion } from "@/lib/sites-types";
import { SITE_STATE } from "./client";
import v from "./versions.module.css";

interface Props {
  site: SiteDetail;
  busy: string | null;
  onPreview: (version: string) => void;
  onRollback: (version: string) => Promise<void>;
}

/**
 * Where each version sits on the rail: by when it was published, from the oldest kept (left) to
 * the draft's last change (right), so a long gap means the draft has moved on a while ago. Ticks
 * published close together are nudged apart enough to stay clickable.
 */
function placeOnRail(times: number[], now: number): number[] {
  if (!times.length) return [];
  const t0 = times[0]!;
  const span = Math.max(now - t0, 1);
  const out = times.map((t) => Math.min(100, ((t - t0) / span) * 100));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i]!, out[i - 1]! + 7);
  // Pushed past the end: pull everything back so the last still fits before the draft.
  const over = out[out.length - 1]! - 100;
  return over > 0 ? out.map((x, i) => Math.max(i * 7, x - over)) : out;
}

/**
 * The site's instrument: what's live, the versions kept behind it, and the draft ahead of it, on
 * one line. Versions are ticks on the rail; open one to look at it or put it back live.
 */
export function VersionStrip({ site, busy, onPreview, onRollback }: Props) {
  const fmt = useFormat();
  const versions = [...site.versions].reverse();
  const at = placeOnRail(
    versions.map((x) => x.createdAt),
    Math.max(versions[versions.length - 1]?.createdAt ?? 0, site.draft.changedAt),
  );
  const [openTick, setOpenTick] = React.useState<string | null>(null);
  const st = SITE_STATE[site.state];
  const url = site.address?.url ?? null;
  const shown = url?.replace(/^https:\/\//, "") ?? "";

  return (
    <section className={v.strip} aria-label="What's live">
      <div className={v.live}>
        <StateLine state={st.line} label={st.label} />
        {url &&
          (site.state === "live" ? (
            <a className={v.url} href={url} target="_blank" rel="noopener noreferrer">
              {shown}
            </a>
          ) : (
            <span className={v.urlOff}>{shown}</span>
          ))}
        {url && <CopyButton value={url} label="Copy the address" />}
      </div>

      <ol className={v.rail} aria-label={`${plural(versions.length, "published version")}, oldest first`}>
        {versions.map((x, i) => (
          <li key={x.version} className={v.stop} style={{ left: `calc((100% - 48px) * ${(at[i]! / 100).toFixed(4)})` }}>
            <Popover
              side="bottom"
              open={openTick === x.version}
              onOpenChange={(o) => setOpenTick(o ? x.version : null)}
              trigger={
                <button type="button" className={v.tick} data-live={x.live ? "" : undefined} aria-label={`${x.live ? "Live version" : "Version"} from ${fmt.dateTime(x.createdAt)}`}>
                  <span className={v.tickMark} aria-hidden />
                </button>
              }
              title={x.live ? "Live now" : "An earlier version"}
            >
              <VersionFacts x={x} />
              <span className={v.popActions}>
                <Button size="sm" onClick={() => (setOpenTick(null), onPreview(x.version))}>
                  Look at it
                </Button>
                {!x.live && (
                  <Button size="sm" loading={busy === x.version} onClick={() => void onRollback(x.version).then(() => setOpenTick(null))}>
                    Put this one live
                  </Button>
                )}
              </span>
            </Popover>
          </li>
        ))}
        <li className={`${v.stop} ${v.draftStop}`}>
          <span className={v.draftMark} data-changes={site.changes ? "" : undefined} aria-hidden />
        </li>
      </ol>

      <div className={v.draft}>
        <span className={v.draftLabel}>Draft</span>
        <span className={v.draftText}>
          {site.changes ? (
            <>
              changed <Time ts={site.draft.changedAt} />
            </>
          ) : (
            "same as live"
          )}
        </span>
      </div>
    </section>
  );
}

function VersionFacts({ x }: { x: SiteVersion }) {
  return (
    <span className={v.facts}>
      <span>
        <Time ts={x.createdAt} kind="dateTime" />
        {x.createdBy ? ` by ${x.createdBy}` : ""}
      </span>
      <span className="num">
        {plural(x.files, "file")}, {formatBytes(x.bytes)}
      </span>
    </span>
  );
}
