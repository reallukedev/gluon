/*
 * Collection previews: each widget drawn as a tiny, faithful schematic of what it shows, in the product's line
 * language. One 120×56 tile per widget, on the panel colour with a hairline. Rules that keep them one family:
 *   - figures are real numerals in the display face; words are 2px rounded strokes (never fake text)
 *   - state marks use StateLine geometry: solid running, dashed starting, short red down, doubled sodium needs you
 *   - 1px hairlines for rules and tracks, 1.5–2px for marks; ink, ink-2 and faint only; no fills beyond sunk
 */
import * as React from "react";
import p from "./previews.module.css";

type Tone = "ink" | "ink2" | "faint" | "line";
type Glyph = "running" | "starting" | "unhealthy" | "attention" | "stopped";

/** A word, as a 2px stroke. */
const W = ({ x, y, w, t = "line" }: { x: number; y: number; w: number; t?: Tone }) => <line x1={x} x2={x + w} y1={y} y2={y} className={p.word} data-t={t} />;
/** A 1px rule. */
const H = ({ x, y, w }: { x: number; y: number; w: number }) => <line x1={x} x2={x + w} y1={y + 0.5} y2={y + 0.5} className={p.rule} />;
/** A figure in the display face. */
const F = ({ x, y, size = 16, children, t = "ink", anchor }: { x: number; y: number; size?: number; children: React.ReactNode; t?: Tone; anchor?: "end" }) => (
  <text x={x} y={y} className={p.fig} data-t={t} style={{ fontSize: size }} textAnchor={anchor}>
    {children}
  </text>
);
/** StateLine geometry at (x, top y) with height h. */
function G({ x, y, h, s }: { x: number; y: number; h: number; s: Glyph }) {
  if (s === "attention")
    return (
      <g className={p.attn}>
        <line x1={x} x2={x} y1={y} y2={y + h} />
        <line x1={x + 4} x2={x + 4} y1={y} y2={y + h} />
      </g>
    );
  if (s === "unhealthy") return <line x1={x} x2={x} y1={y + h * 0.55} y2={y + h} className={p.fault} />;
  return <line x1={x} x2={x} y1={y} y2={y + h} className={p.glyph} data-s={s} />;
}
/** A usage track with its fill. */
const Bar = ({ x, y, w, v, attn }: { x: number; y: number; w: number; v: number; attn?: boolean }) => (
  <g>
    <rect x={x} y={y} width={w} height={3} rx={1.5} className={p.track} />
    <rect x={x} y={y} width={Math.max(2, w * v)} height={3} rx={1.5} className={attn ? p.fillAttn : p.fill} />
  </g>
);
/** A trace through points given as 0…1 heights. */
function Trace({ x, y, w, h, v, area }: { x: number; y: number; w: number; h: number; v: number[]; area?: boolean }) {
  const pts = v.map((k, i) => [x + (i / (v.length - 1)) * w, y + h - k * h] as const);
  const d = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join("");
  return (
    <g>
      {area && <path d={`${d}L${x + w} ${y + h}L${x} ${y + h}Z`} className={p.area} />}
      <path d={d} className={p.trace} />
    </g>
  );
}
const Square = ({ x, y, s, r = 3, dim }: { x: number; y: number; s: number; r?: number; dim?: boolean }) => (
  <rect x={x + 0.5} y={y + 0.5} width={s - 1} height={s - 1} rx={r} className={p.thumb} data-dim={dim ? "" : undefined} />
);
const Poster = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={2} className={p.thumb} />;

const DRAWINGS: Record<string, () => React.ReactNode> = {
  greeting: () => (
    <>
      <text x={12} y={30} className={p.fig} style={{ fontSize: 15 }}>
        Good morning,
      </text>
      <W x={12} y={42} w={34} t="faint" />
    </>
  ),
  search: () => (
    <>
      <rect x={10.5} y={17.5} width={99} height={21} rx={7} className={p.field} />
      <circle cx={21} cy={27.5} r={3.5} className={p.lens} />
      <line x1={23.6} x2={26} y1={30.1} y2={32.5} className={p.lens} />
      <W x={32} y={28} w={36} t="faint" />
    </>
  ),
  folder: () => (
    <>
      <rect x={10.5} y={14.5} width={99} height={27} rx={6} className={p.plate} />
      <rect x={16.5} y={20.5} width={15} height={15} rx={4} className={p.thumb} />
      <path d="M20 25.5h3l1 1h4.5v5h-8.5z" className={p.chev} />
      <W x={38} y={25} w={36} t="ink" />
      <W x={38} y={32} w={24} t="faint" />
    </>
  ),
  link: () => (
    <>
      <rect x={10.5} y={14.5} width={99} height={27} rx={6} className={p.plate} />
      <rect x={16.5} y={20.5} width={15} height={15} rx={4} className={p.thumb} />
      <text x={24} y={31} className={p.small} data-t="ink2" textAnchor="middle">
        G
      </text>
      <W x={38} y={25} w={30} t="ink" />
      <W x={38} y={32} w={40} t="faint" />
    </>
  ),
  clock: () => (
    <>
      <F x={12} y={34} size={27}>
        9:41
      </F>
      <W x={12} y={45} w={40} t="ink2" />
    </>
  ),
  links: () => (
    <>
      {[
        [12, 15],
        [64, 15],
        [12, 35],
        [64, 35],
      ].map(([x, y]) => (
        <g key={`${x}${y}`}>
          <rect x={x! + 0.5} y={y! - 4.5} width={8} height={8} rx={2} className={p.thumb} />
          <W x={x! + 13} y={y! - 2} w={26} t="ink2" />
          <W x={x! + 13} y={y! + 3} w={16} t="faint" />
        </g>
      ))}
    </>
  ),
  notes: () => (
    <>
      {[17, 27, 37, 47].map((y) => (
        <H key={y} x={12} y={y} w={96} />
      ))}
      <W x={13} y={14} w={62} t="ink2" />
      <W x={13} y={24} w={40} t="ink2" />
    </>
  ),
  apps: () => (
    <>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={10.5 + i * 25} y={8.5} width={21} height={34} rx={4} className={i === 3 ? p.dashCard : p.card} />
          {i < 3 ? (
            <>
              <Square x={15 + i * 25} y={14} s={12} r={3} />
              <W x={16 + i * 25} y={35} w={10} t="ink2" />
            </>
          ) : (
            <>
              <line x1={21 + i * 25} x2={21 + i * 25} y1={21.5} y2={29.5} className={p.plus} />
              <line x1={17 + i * 25} x2={25 + i * 25} y1={25.5} y2={25.5} className={p.plus} />
            </>
          )}
        </g>
      ))}
    </>
  ),
  app: () => (
    <>
      <Square x={12} y={10} s={16} r={4} />
      <W x={34} y={15} w={40} t="ink" />
      <G x={34} y={20} h={6} s="running" />
      <W x={38} y={23} w={22} t="faint" />
      <Trace x={12} y={34} w={96} h={12} v={[0.3, 0.35, 0.3, 0.5, 0.45, 0.7, 0.55, 0.6, 0.4, 0.55]} />
      <line x1={108} x2={108} y1={33} y2={47} className={p.now} />
    </>
  ),
  status: () => (
    <>
      <G x={12} y={10} h={12} s="attention" />
      <W x={22} y={13} w={62} t="ink" />
      <W x={22} y={20} w={38} t="faint" />
      <H x={12} y={28} w={96} />
      <G x={13} y={32} h={8} s="unhealthy" />
      <W x={19} y={37} w={48} t="ink2" />
      <W x={88} y={37} w={20} t="faint" />
      <H x={12} y={42} w={96} />
      <G x={12} y={45} h={7} s="attention" />
      <W x={21} y={49} w={40} t="ink2" />
    </>
  ),
  spectrum: () => (
    <>
      {Array.from({ length: 22 }, (_, i) => {
        const x = 13 + i * 4.5 + (i > 7 ? 3 : 0) + (i > 15 ? 3 : 0);
        const s: Glyph = i === 5 ? "unhealthy" : i === 12 ? "attention" : i === 18 ? "starting" : i === 9 || i === 20 ? "stopped" : "running";
        return <G key={i} x={x} y={12} h={30} s={s} />;
      })}
      <H x={12} y={46} w={34} />
      <H x={52} y={46} w={33} />
      <H x={91} y={46} w={18} />
    </>
  ),
  vitals: () => (
    <>
      <W x={12} y={11} w={14} t="faint" />
      <F x={12} y={28} size={16}>
        12%
      </F>
      <Trace x={12} y={34} w={42} h={12} v={[0.2, 0.3, 0.15, 0.4, 0.25, 0.3, 0.2, 0.5, 0.3]} area />
      <W x={66} y={11} w={20} t="faint" />
      <F x={66} y={28} size={16}>
        48%
      </F>
      <Trace x={66} y={34} w={42} h={12} v={[0.48, 0.5, 0.5, 0.52, 0.5, 0.49, 0.51, 0.5, 0.5]} area />
    </>
  ),
  network: () => (
    <>
      <line x1={12} x2={108} y1={33.5} y2={33.5} className={p.rail} />
      {Array.from({ length: 32 }, (_, i) => {
        const x = 13 + i * 3;
        const up = [4, 6, 5, 9, 14, 20, 12, 7, 5, 4, 6, 8, 5, 4, 3, 5, 18, 16, 9, 6, 4, 5, 7, 5, 4, 6, 10, 8, 5, 4, 5, 6][i]!;
        const down = Math.max(1, Math.round(up * 0.45));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={32} y2={32 - up} className={p.tickIn} />
            <line x1={x} x2={x} y1={35} y2={35 + down} className={p.tickOut} />
          </g>
        );
      })}
    </>
  ),
  storage: () => (
    <>
      {[
        [13, 0.34, false],
        [28, 0.58, false],
        [43, 0.9, true],
      ].map(([y, v, a]) => (
        <g key={y as number}>
          <W x={12} y={(y as number) - 2} w={30} t="ink2" />
          <W x={88} y={(y as number) - 2} w={20} t="faint" />
          <Bar x={12} y={(y as number) + 3} w={96} v={v as number} attn={a as boolean} />
        </g>
      ))}
      <line x1={93.5} x2={93.5} y1={45} y2={49} className={p.thresh} />
    </>
  ),
  "now-playing": () => (
    <>
      <Poster x={12} y={9} w={22} h={33} />
      <W x={42} y={15} w={52} t="ink" />
      <W x={42} y={22} w={34} t="faint" />
      <line x1={42} x2={108} y1={36.5} y2={36.5} className={p.rule} />
      <line x1={42} x2={78} y1={36.5} y2={36.5} className={p.progress} />
    </>
  ),
  shelf: () => (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <Poster x={12 + i * 20} y={8} w={16} h={24} />
          <W x={12 + i * 20} y={38} w={14} t="ink2" />
          <W x={12 + i * 20} y={44} w={9} t="faint" />
        </g>
      ))}
    </>
  ),
  counts: () => (
    <>
      <W x={12} y={13} w={22} t="faint" />
      <F x={12} y={36} size={20}>
        412
      </F>
      <W x={64} y={13} w={18} t="faint" />
      <F x={64} y={36} size={20} t="ink2">
        86
      </F>
    </>
  ),
  photos: () => (
    <>
      <W x={12} y={12} w={18} t="faint" />
      <F x={12} y={31} size={17}>
        8,412
      </F>
      <W x={66} y={12} w={18} t="faint" />
      <F x={66} y={31} size={17} t="ink2">
        316
      </F>
      <Bar x={12} y={42} w={96} v={0.62} />
    </>
  ),
  wall: () => (
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <Square key={i} x={12 + (i % 5) * 19.5} y={9 + Math.floor(i / 5) * 19.5} s={17} r={2.5} />
      ))}
      <path d="M70.5 35.5l4 2.5-4 2.5z" className={p.play} />
    </>
  ),
  "on-this-day": () => (
    <>
      <rect x={4.5} y={4.5} width={111} height={47} rx={4} className={p.photo} />
      <path d="M5 38l16-12 12 8 18-17 22 19 12-9 30 18" className={p.ridge} />
      <rect x={9.5} y={33.5} width={30} height={14} rx={3} className={p.plate} />
      <F x={14} y={44.5} size={10}>
        2019
      </F>
      <rect x={88.5} y={37.5} width={22} height={10} rx={3} className={p.plate} />
      <path d="M96 40.5l-2 2 2 2M103 40.5l2 2-2 2" className={p.chev} />
    </>
  ),
  "music-now": () => (
    <>
      <Square x={12} y={10} s={26} r={3} />
      <W x={46} y={16} w={50} t="ink" />
      <W x={46} y={23} w={36} t="faint" />
      <W x={46} y={34} w={24} t="faint" />
    </>
  ),
  "music-shelf": () => (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <Square x={12 + i * 20} y={10} s={17} r={2} />
          <W x={12 + i * 20} y={35} w={14} t="ink2" />
          <W x={12 + i * 20} y={41} w={9} t="faint" />
        </g>
      ))}
    </>
  ),
  transfers: () => (
    <>
      {[
        [12, 0.72, false],
        [27, 0.34, false],
        [42, 0.16, true],
      ].map(([y, v, q]) => (
        <g key={y as number}>
          <path d={`M13 ${(y as number) - 3}v6m-2.5-2.5l2.5 2.5 2.5-2.5`} className={p.arrow} />
          <W x={22} y={(y as number) - 2} w={48} t="ink2" />
          <line x1={22} x2={108} y1={(y as number) + 4.5} y2={(y as number) + 4.5} className={p.rule} />
          <line x1={22} x2={22 + 86 * (v as number)} y1={(y as number) + 4.5} y2={(y as number) + 4.5} className={q ? p.progressWait : p.progress} />
        </g>
      ))}
    </>
  ),
  accessories: () => (
    <>
      {[
        [12, 8, true],
        [63, 8, false],
        [12, 30, false],
        [63, 30, true],
      ].map(([x, y, on]) => (
        <g key={`${x}${y}`}>
          <rect x={(x as number) + 0.5} y={(y as number) + 0.5} width={44} height={18} rx={4} className={p.acc} data-on={on ? "" : undefined} />
          <circle cx={(x as number) + 8} cy={(y as number) + 7} r={2.5} className={p.accIcon} data-on={on ? "" : undefined} />
          <W x={(x as number) + 6} y={(y as number) + 14} w={22} t={on ? "ink2" : "faint"} />
        </g>
      ))}
    </>
  ),
  values: () => (
    <>
      <W x={12} y={13} w={20} t="faint" />
      <F x={12} y={36} size={20}>
        42
      </F>
      <W x={64} y={13} w={24} t="faint" />
      <F x={64} y={36} size={20}>
        7d
      </F>
    </>
  ),
  weather: () => (
    <>
      <F x={12} y={34} size={26}>
        18°
      </F>
      <W x={12} y={45} w={30} t="faint" />
      <Trace x={56} y={16} w={52} h={22} v={[0.3, 0.45, 0.7, 0.85, 0.8, 0.6, 0.4, 0.3]} />
    </>
  ),
  calendar: () => (
    <>
      <W x={12} y={10} w={18} t="faint" />
      <H x={12} y={14} w={96} />
      {[22, 34, 46].map((y, i) => (
        <g key={y}>
          <text x={12} y={y + 2} className={p.small} data-t={i === 0 ? "ink" : "faint"}>
            {["09:00", "13:30", "18:00"][i]}
          </text>
          <W x={40} y={y} w={[54, 40, 48][i]!} t={i === 0 ? "ink" : "ink2"} />
        </g>
      ))}
      <line x1={8} x2={8} y1={18} y2={26} className={p.glyph} data-s="running" />
    </>
  ),
  feed: () => (
    <>
      {[12, 27, 42].map((y, i) => (
        <g key={y}>
          <W x={12} y={y} w={[86, 70, 80][i]!} t="ink2" />
          <W x={12} y={y + 6} w={[34, 28, 40][i]!} t="faint" />
        </g>
      ))}
    </>
  ),
  "link-status": () => (
    <>
      <G x={12} y={10} h={12} s="running" />
      <W x={20} y={16} w={46} t="ink" />
      <F x={12} y={44} size={18}>
        42
      </F>
      <text x={33} y={44} className={p.small} data-t="faint">
        ms
      </text>
    </>
  ),
  uptime: () => (
    <>
      {[12, 30].map((y, r) => (
        <g key={y}>
          <G x={12} y={y - 4} h={8} s="running" />
          <W x={18} y={y} w={44} t="ink2" />
          <text x={108} y={y + 2} className={p.small} data-t="faint" textAnchor="end">
            {r ? "100%" : "99.8%"}
          </text>
          {Array.from({ length: 30 }, (_, i) => {
            const bad = r === 0 && (i === 19 || i === 20);
            const x = 18.5 + i * 3;
            return <line key={i} x1={x} x2={x} y1={bad ? y + 10 : y + 6} y2={y + 13} className={bad ? p.fault : p.tickIn} />;
          })}
        </g>
      ))}
    </>
  ),
  activity: () => (
    <>
      {[12, 26, 40].map((y, i) => (
        <g key={y}>
          <G x={12} y={y - 4} h={8} s={i === 1 ? "stopped" : "running"} />
          <W x={18} y={y - 1} w={[58, 46, 52][i]!} t="ink2" />
          <W x={18} y={y + 5} w={18} t="faint" />
        </g>
      ))}
    </>
  ),
  drives: () => (
    <>
      <G x={12} y={8} h={12} s="running" />
      <W x={20} y={14} w={54} t="ink" />
      {[28, 42].map((y, i) => (
        <g key={y}>
          <H x={12} y={y - 7} w={96} />
          <G x={12} y={y - 3} h={8} s="running" />
          <W x={18} y={y} w={[42, 34][i]!} t="ink2" />
          <text x={108} y={y + 2} className={p.small} data-t="faint" textAnchor="end">
            {["34°", "41°"][i]}
          </text>
        </g>
      ))}
    </>
  ),
  busy: () => (
    <>
      {[
        [12, 1],
        [27, 0.56],
        [42, 0.3],
      ].map(([y, v]) => (
        <g key={y}>
          <Square x={12} y={y! - 5} s={9} r={2} />
          <W x={26} y={y! - 1} w={40} t="ink2" />
          <W x={94} y={y! - 1} w={14} t="faint" />
          <Bar x={26} y={y! + 3} w={82} v={v!} />
        </g>
      ))}
    </>
  ),
  logins: () => (
    <>
      <G x={12} y={8} h={12} s="running" />
      <W x={20} y={14} w={56} t="ink" />
      {[30, 44].map((y, i) => (
        <g key={y}>
          <H x={12} y={y - 8} w={96} />
          <G x={12} y={y - 4} h={8} s="running" />
          <W x={18} y={y - 1} w={[36, 30][i]!} t="ink2" />
          <W x={18} y={y + 4} w={[52, 44][i]!} t="faint" />
        </g>
      ))}
    </>
  ),
  internet: () => (
    <>
      <G x={12} y={8} h={10} s="running" />
      <W x={18} y={13} w={40} t="ink2" />
      <F x={12} y={33} size={15}>
        14
      </F>
      <text x={29} y={33} className={p.small} data-t="faint">
        ms
      </text>
      <line x1={12} x2={108} y1={49.5} y2={49.5} className={p.rail} />
      {Array.from({ length: 33 }, (_, i) => {
        const x = 12.75 + i * 2.95;
        const down = i === 21;
        const slow = i === 9 || i === 10;
        return <line key={i} x1={x} x2={x} y1={down ? 44 : 38} y2={49} className={down ? p.fault : slow ? p.tickSlow : p.tickIn} />;
      })}
    </>
  ),
  "guest-wifi": () => {
    // A stylised code on its light card: three finder squares and a fixed scatter of modules (4px each).
    const rows = ["FFF010FFF", "FFF101FFF", "FFF011FFF", "010110101", "101011010", "011101101", "FFF010110", "FFF101011", "FFF110101"];
    return (
      <>
        <rect x={8.5} y={4.5} width={43} height={43} rx={3} className={p.qrPlate} />
        {[
          [12, 8],
          [36, 8],
          [12, 32],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <rect x={x! + 0.75} y={y! + 0.75} width={10.5} height={10.5} className={p.qrRing} />
            <rect x={x! + 4} y={y! + 4} width={4} height={4} className={p.qrDot} />
          </g>
        ))}
        {rows.flatMap((row, r) => row.split("").map((c, k) => (c === "1" ? <rect key={`${r}-${k}`} x={12 + k * 4} y={8 + r * 4} width={4} height={4} className={p.qrDot} /> : null)))}
        <W x={60} y={16} w={20} t="faint" />
        <W x={60} y={24} w={44} t="ink" />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <circle key={i} cx={61.5 + i * 5} cy={34} r={1.4} className={p.dot} />
        ))}
      </>
    );
  },
  space: () => (
    <>
      <G x={12} y={8} h={12} s="attention" />
      <W x={21} y={14} w={48} t="ink" />
      <W x={12} y={25} w={32} t="faint" />
      <rect x={12} y={36} width={96} height={3} rx={1.5} className={p.track} />
      <rect x={12} y={36} width={62} height={3} rx={1.5} className={p.fill} />
      <line x1={75} x2={107} y1={37.5} y2={37.5} className={p.projection} />
      <line x1={108.5} x2={108.5} y1={33} y2={42} className={p.thresh} />
      <text x={108} y={50} className={p.small} data-t="ink2" textAnchor="end">
        9 days
      </text>
    </>
  ),
  power: () => (
    <>
      <F x={12} y={27} size={20}>
        38
      </F>
      <text x={35} y={27} className={p.small} data-t="faint">
        W
      </text>
      <Trace x={12} y={33} w={96} h={13} v={[0.3, 0.32, 0.28, 0.6, 0.9, 0.5, 0.35, 0.3, 0.33, 0.7, 0.4, 0.32]} />
      <line x1={108} x2={108} y1={32} y2={47} className={p.now} />
    </>
  ),
  schedule: () => (
    <>
      <W x={12} y={9} w={20} t="faint" />
      <H x={12} y={13} w={96} />
      {[21, 33, 45].map((y, i) => (
        <g key={y}>
          {i > 0 && <H x={12} y={y - 7} w={96} />}
          <text x={12} y={y + 2} className={p.small} data-t={i === 0 ? "ink" : "ink2"}>
            {["00:35", "01:21", "06:35"][i]}
          </text>
          <W x={40} y={y} w={[46, 38, 54][i]!} t={i === 0 ? "ink" : "ink2"} />
        </g>
      ))}
    </>
  ),
};

export type PreviewKind = keyof typeof DRAWINGS;

/** The catalog drawing for a widget: a miniature tile with its schematic. */
export function Preview({ of }: { of: string }) {
  const draw = DRAWINGS[of];
  return (
    <svg className={p.preview} viewBox="0 0 120 56" width={120} height={56} aria-hidden focusable="false">
      <rect x={0.5} y={0.5} width={119} height={55} rx={6} className={p.tile} />
      {draw?.()}
    </svg>
  );
}
