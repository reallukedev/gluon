"use client";
import * as React from "react";
import Link from "next/link";
import { useFormat } from "@/components/PrefsProvider";
import { StateLine } from "@/components/ui/StateLine";
import type { DiskView, VolumeView } from "@/lib/storage-types";
import { DiskGlyph } from "./DiskGlyph";
import { diskLine, MEDIA_SHORT, notPermanent, smartLine, smartPhrase, transportLabel, volumeLine } from "./shared";
import s from "./storage.module.css";

interface Segment {
  key: string;
  size: number;
  vol: VolumeView | null;
}

function segmentsOf(d: DiskView): Segment[] {
  if (d.wholeDisk) return [{ key: d.wholeDisk.name, size: d.size, vol: d.wholeDisk }];
  const segs: Segment[] = d.partitions.map((p) => ({ key: p.name, size: p.size, vol: p }));
  if (d.unallocated > 0) segs.push({ key: "free", size: d.unallocated, vol: null });
  return segs;
}

function roleWord(v: VolumeView): string {
  switch (v.role) {
    case "swap":
      return "swap";
    case "lvm-member":
      return "LVM";
    case "raid-member":
      return "RAID";
    case "encrypted":
      return "encrypted";
    case "bios-boot":
      return "boot";
    case "unformatted":
      return "unformatted";
    default:
      return v.fstype ?? "unknown";
  }
}

// ---------------------------------------------------------------- layout

const MIN_SEG = 5;
const PAD = 24;
const ROW_H = 20;
const ROW_GAP = 14;
const MAX_ROWS = 3;
/** Approximate advance widths: JetBrains Mono at 12px is exactly 0.6em; Archivo 11px averages ~5.6px. */
const monoW = (t: string) => t.length * 7.25;
const sansW = (t: string, px = 11) => t.length * px * 0.53;

interface Placed {
  seg: Segment;
  x: number;
  w: number;
  name: string;
  mono: boolean;
  sub: string;
  inline: "full" | "name" | null;
  callout: { row: number; left: number; width: number } | null;
}

/**
 * Widths at the true share of the disk, but never thinner than a visible sliver: slivers take their
 * minimum and the rest share what's left in proportion.
 */
function widths(sizes: number[], W: number): number[] {
  const out = sizes.map(() => 0);
  const fixed = new Set<number>();
  for (let pass = 0; pass < sizes.length; pass++) {
    const free = W - [...fixed].length * MIN_SEG;
    const rest = sizes.reduce((a, v, i) => (fixed.has(i) ? a : a + v), 0) || 1;
    let changed = false;
    sizes.forEach((v, i) => {
      if (fixed.has(i)) return (out[i] = MIN_SEG);
      const w = (v / rest) * free;
      if (w < MIN_SEG) {
        fixed.add(i);
        changed = true;
      }
      out[i] = w;
    });
    if (!changed) break;
  }
  return out;
}

/**
 * Where every label goes. A partition wide enough carries its name inside; the rest hang their label
 * below on a hairline dropped from their middle (like the spectrum's stack callouts): each takes the
 * first of three rows where it clears the previous label, else the row that frees up soonest.
 */
function layout(segs: { seg: Segment; name: string; mono: boolean; sub: string }[], W: number): { placed: Placed[]; rows: number } {
  const ws = widths(
    segs.map((x) => x.seg.size),
    W,
  );
  let x = 0;
  const placed: Placed[] = segs.map((it, i) => {
    const w = ws[i]!;
    const nameW = it.mono ? monoW(it.name) : sansW(it.name, 13) * 1.05;
    const subW = sansW(it.sub);
    const inline = w >= Math.max(nameW, subW) + PAD ? "full" : w >= nameW + PAD ? "name" : null;
    const p: Placed = { ...it, x, w, inline, callout: null };
    x += w;
    return p;
  });
  const rowEnd: number[] = [];
  for (const p of placed) {
    if (p.inline) continue;
    const width = Math.min(W, (p.mono ? monoW(p.name) : sansW(p.name, 12)) + 10 + sansW(p.sub) + 10);
    const anchor = p.x + p.w / 2;
    const ideal = Math.max(0, Math.min(W - width, anchor - 6));
    let row = rowEnd.findIndex((end) => ideal >= end + 12);
    if (row < 0 && rowEnd.length < MAX_ROWS) row = rowEnd.length;
    if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
    const left = Math.min(Math.max(ideal, (rowEnd[row] ?? -12) + 12), Math.max(0, W - width));
    rowEnd[row] = left + width;
    p.callout = { row, left, width };
  }
  return { placed, rows: rowEnd.length };
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- the strip

/**
 * The partitions of a disk drawn to scale as one strip, each filled to how much of it is used, with
 * its state carried by the mark on its left edge. Tiny partitions stay legible through callouts.
 */
export function DiskSegments({ disk, tall }: { disk: DiskView; tall?: boolean }) {
  const fmt = useFormat();
  const [ref, W] = useWidth<HTMLDivElement>();
  const segs = segmentsOf(disk);
  const labelled = segs.map((seg) => {
    if (!seg.vol) return { seg, name: "Free", mono: false, sub: `${fmt.bytes(seg.size)} not partitioned` };
    const v = seg.vol;
    const name = v.primaryMount ?? (v.swapActive ? "swap" : (v.label ?? v.name));
    const sub = [roleWord(v), v.usage ? `${fmt.bytes(v.usage.avail)} free` : fmt.bytes(v.size)].join(" · ");
    return { seg, name, mono: !!v.primaryMount, sub };
  });
  // Before the strip is measured (server render), lay it out on a nominal width in percentages.
  const Wl = W || 1000;
  const pct = (px: number) => `${(px / Wl) * 100}%`;
  const { placed, rows } = layout(labelled, Wl);
  const describe = labelled
    .map(({ seg, name, sub }) => (seg.vol ? `${name}${seg.vol.primaryMount ? "" : ` (${seg.vol.name})`}, ${sub}${notPermanent(seg.vol, disk) ? ", won't come back after a restart" : ""}` : `${fmt.bytes(seg.size)} not partitioned`))
    .join("; ");

  return (
    <div className={s.strip} ref={ref}>
      <div
        className={s.bar}
        data-tall={tall ? "" : undefined}
        data-disk-state={disk.smart?.state === "asleep" ? "asleep" : disk.state}
        role="img"
        aria-label={`${disk.title}${segs.length ? `: ${describe}` : `: ${disk.mediaPresent ? "blank, no partitions" : "nothing inserted"}`}`}
      >
        {segs.length === 0 ? (
          <span className={s.seg} data-empty="" style={{ left: 0, width: "100%" }}>
            <span className={s.segText}>
              <span className={s.segName}>{disk.mediaPresent ? "Blank" : "Nothing inserted"}</span>
              {disk.mediaPresent && <span className={s.segSub}>No partitions</span>}
            </span>
          </span>
        ) : (
          placed.map((p) => <SegmentView key={p.seg.key} p={p} disk={disk} pct={pct} />)
        )}
      </div>
      {rows > 0 && (
        <div className={s.callouts} style={{ height: rows * ROW_H + (rows - 1) * 2 + ROW_GAP }} aria-hidden>
          {placed
            .filter((p) => p.callout)
            .sort((a, b) => b.callout!.row - a.callout!.row)
            .map((p) => {
              const c = p.callout!;
              const top = ROW_GAP + c.row * (ROW_H + 2);
              const anchor = Math.round(p.x + p.w / 2);
              return (
                <React.Fragment key={p.seg.key}>
                  <span className={s.leader} style={{ left: pct(anchor), height: top + 4 }} />
                  <span className={s.callout} style={{ left: pct(c.left), top, maxWidth: pct(Wl - c.left) }} data-row={c.row}>
                    <span className={p.mono ? "mono" : undefined}>{p.name}</span>
                    <span className={`${s.calloutSub} num`}>{p.sub}</span>
                  </span>
                </React.Fragment>
              );
            })}
        </div>
      )}
    </div>
  );
}

function SegmentView({ p, disk, pct }: { p: Placed; disk: DiskView; pct: (px: number) => string }) {
  const fmt = useFormat();
  const style = { left: pct(p.x), width: pct(p.w) };
  if (!p.seg.vol) {
    return (
      <span className={s.seg} data-free="" style={style} title={`${fmt.bytes(p.seg.size)} not partitioned`}>
        {p.inline && (
          <span className={s.segText}>
            <span className={s.segName}>Free</span>
            {p.inline === "full" && <span className={s.segSub}>{fmt.bytes(p.seg.size)}</span>}
          </span>
        )}
      </span>
    );
  }
  const v = p.seg.vol;
  const state = volumeLine(v, disk);
  const used = v.usage ? Math.min(100, (v.usage.used / Math.max(1, v.usage.size)) * 100) : null;
  const title = [
    `${v.name}${v.label ? ` "${v.label}"` : ""}: ${fmt.bytes(v.size)} ${roleWord(v)}`,
    v.primaryMount ? `mounted at ${v.primaryMount}` : v.swapActive ? "active swap" : "not mounted",
    v.usage ? `${Math.round(used!)}% used, ${fmt.bytes(v.usage.avail)} free` : null,
    notPermanent(v, disk) ? "won't come back after a restart" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={s.seg} data-state={state} style={style} title={title}>
      {used !== null && <span className={s.segFill} style={{ width: `${used}%` }} aria-hidden />}
      <span className={s.segMark} aria-hidden />
      {p.inline && (
        <span className={s.segText}>
          <span className={`${s.segName} ${p.mono ? "mono" : ""}`}>{p.name}</span>
          {p.inline === "full" && <span className={`${s.segSub} num`}>{p.sub}</span>}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- the disk as an object

/** "4 months", "3.2 years": how long a drive has been powered on, in words a person uses. */
export function onForText(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  const months = days / 30.44;
  if (months < 24) return `${Math.round(months)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/** The spec line under each disk, like the label on the drive itself: engraved names, plain values. */
export function DiskFacts({ disk }: { disk: DiskView }) {
  const fmt = useFormat();
  const sm = disk.smart;
  const facts: { k: string; v: React.ReactNode; title?: string }[] = [];
  if (disk.model) facts.push({ k: "Model", v: <span className={s.specModel}>{disk.model}</span>, title: disk.model });
  facts.push({ k: "Type", v: [MEDIA_SHORT[disk.media], transportLabel(disk)].filter(Boolean).join(" · ") });
  if (disk.mediaPresent) facts.push({ k: "Size", v: <span className="num">{fmt.bytes(disk.size)}</span> });
  if (disk.mediaPresent && !disk.removable) facts.push({ k: "Health", v: <StateLine state={smartLine(sm)} size={11} label={smartPhrase(sm)} /> });
  if (sm?.temperature !== null && sm?.temperature !== undefined && sm.state !== "asleep") {
    const near = sm.tempLimit !== null && sm.temperature >= sm.tempLimit - 5;
    facts.push({
      k: "Temp",
      v: (
        <span className="num" data-near={near ? "" : undefined}>
          {fmt.temp(sm.temperature)}
          {sm.tempLimit ? <span className={s.specDim}> of {fmt.temp(sm.tempLimit)}</span> : null}
        </span>
      ),
      title: sm.tempLimit ? `Rated for up to ${fmt.temp(sm.tempLimit)}` : undefined,
    });
  }
  if (sm?.powerOnHours) facts.push({ k: "On for", v: <span className="num">{onForText(sm.powerOnHours)}</span>, title: `${sm.powerOnHours.toLocaleString()} hours powered on` });
  return (
    <dl className={s.spec}>
      {facts.map((f) => (
        <div key={f.k} className={s.specItem} title={f.title}>
          <dt className={s.specKey}>{f.k}</dt>
          <dd>{f.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A disk as it appears on the overview: what it is, its state, the strip, the spec line. Opens the disk. */
export function DiskRow({ disk }: { disk: DiskView }) {
  const href = `/storage/${encodeURIComponent(disk.id)}`;
  return (
    <li className={s.disk}>
      <Link href={href} className={s.diskLink} aria-label={`${disk.title}${disk.model ? `, ${disk.model}` : ""}: ${disk.summary}`}>
        <div className={s.diskHead}>
          <span className={s.diskGlyph} data-state={diskLine(disk)}>
            <DiskGlyph media={disk.media} size={22} />
          </span>
          <span className={s.diskName}>
            <span className={s.diskTitle}>
              <StateLine state={diskLine(disk)} size={13} />
              {disk.title}
              <span className={`${s.diskDev} mono`}>{disk.name}</span>
            </span>
            <span className={s.diskSummary}>{disk.summary}</span>
          </span>
        </div>
        <DiskSegments disk={disk} />
        <DiskFacts disk={disk} />
      </Link>
    </li>
  );
}
