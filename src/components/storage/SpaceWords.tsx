"use client";
import Link from "next/link";
import type { SpaceData } from "@/lib/home-widgets-types";
import type { FsUsage } from "@/server/metrics/sampler";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { UsageBar } from "@/components/ui/Surface";
import { timeLeft } from "@/lib/words";
import w from "./spaceWords.module.css";

interface Row {
  mount: string;
  pct: number;
  used: number;
  size: number;
  avail: number;
  daysToFull: number | null;
}

/**
 * Each filesystem in numbers: "62% full · 1.1 of 1.8 TB · about 8 months left" when it's filling,
 * otherwise what's free. The forecast is last week's rate (the same one Home's space widget uses);
 * until there's history, rows say what's free instead of guessing.
 */
export function SpaceWords({ fallback, attention }: { fallback?: FsUsage[]; attention?: Set<string> }) {
  const fmt = useFormat();
  const { data } = useApi<SpaceData>("/api/widgets/space", { refresh: 60_000 });
  const rows: Row[] =
    data?.disks ??
    (fallback ?? [])
      .filter((f) => f.size > 512 * 1024 * 1024)
      .map((f) => ({
        mount: f.mount,
        pct: f.pct,
        used: f.used,
        size: f.size,
        avail: f.avail,
        daysToFull: null,
      }));
  if (!rows.length) return data ? <p className={w.none}>No drives with space to show.</p> : null;
  return (
    <ul className={w.list} role="list">
      {rows.map((r) => {
        const left = timeLeft(r.daysToFull);
        const needs = attention?.has(r.mount) || r.pct >= 85;
        return (
          <li key={r.mount} className={w.row} title={`${fmt.bytes(r.avail)} free`}>
            <div className={w.head}>
              <Link href={`/storage?tab=space&usage=${encodeURIComponent(r.mount)}`} className={`${w.mount} mono`} title={r.mount}>
                {r.mount}
              </Link>
              <span className={w.val} data-attn={needs ? "" : undefined}>
                <b className="num">{Math.round(r.pct)}% full</b>
                <span className="num">
                  {" "}
                  · {fmt.bytes(r.used)} of {fmt.bytes(r.size)} · {left ?? `${fmt.bytes(r.avail)} free`}
                </span>
              </span>
            </div>
            <UsageBar value={r.pct} attention={85} fault={95} label={`${r.mount}: ${Math.round(r.pct)}% full${left ? `, ${left}` : ""}`} />
          </li>
        );
      })}
    </ul>
  );
}
