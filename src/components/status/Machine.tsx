"use client";
import { Skeleton } from "@/components/ui/Surface";
import { Reading } from "@/components/charts/Reading";
import { useMachineReadings } from "@/components/charts/readings";
import s from "./status.module.css";

/** The machine in four live readings, each a figure, its context in numbers, and a chart. */
export function MachineVitals() {
  const { readings, status, span, windowMs } = useMachineReadings();
  const list = [readings.cpu, readings.mem, readings.net, readings.disk];

  if (!readings.cpu) {
    return (
      <div className={s.vitals} aria-busy="true" aria-label="Loading live readings">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.vital}>
            <Skeleton width={70} height={11} />
            <Skeleton width={90} height={26} style={{ marginTop: 6 }} />
            <Skeleton width={140} height={11} style={{ marginTop: 6 }} />
            <Skeleton height={56} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <ul className={s.vitals} role="list" data-offline={status === "offline" ? "" : undefined}>
      {list.map((g) =>
        g ? (
          <li key={g.key} className={s.vital}>
            <Reading reading={g} span={span} windowMs={windowMs} ground="ground" />
          </li>
        ) : null,
      )}
    </ul>
  );
}
