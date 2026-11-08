import { MARK_20 } from "./mark";

export function GluonMark({ className, title }: { className?: string; title?: string }) {
  const { coil, y, x0, x1 } = MARK_20;
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={coil} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x0} cy={y} r="2" fill="currentColor" />
      <circle cx={x1} cy={y} r="2" fill="currentColor" />
    </svg>
  );
}
