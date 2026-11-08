import { MARK_64 } from "@/components/brand/mark";
import o from "./onboarding.module.css";

export function Bond({ from, to, draw = false }: { from: string; to: string; draw?: boolean }) {
  const { coil, y, x0, x1 } = MARK_64;
  return (
    <div className={o.bond} data-draw={draw ? "" : undefined} aria-hidden>
      <span className={o.bondEnd} title={from}>
        {from}
      </span>
      <svg className={o.bondCoil} viewBox="12 17 40 25" fill="none">
        <path d={coil} pathLength={1} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x0} cy={y} r="2.4" fill="currentColor" />
        <circle cx={x1} cy={y} r="2.4" fill="currentColor" />
      </svg>
      <span className={o.bondEnd} title={to}>
        {to}
      </span>
    </div>
  );
}
