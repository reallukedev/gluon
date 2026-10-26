"use client";
import { Combobox } from "@base-ui/react/combobox";
import { Check, NavArrowDown } from "iconoir-react";
import { useApi } from "@/lib/client/api";
import { Skeleton } from "@/components/ui/Surface";
import p from "@/components/ui/popup.module.css";
import s from "./system.module.css";

const label = (tz: string) => tz.replace(/_/g, " ").replace(/\//g, " / ");

/** Searchable timezone select over the server's own list (`timedatectl list-timezones`). */
export function TimezonePicker({ value, onChange, disabled }: { value: string | null; onChange: (tz: string) => void; disabled?: boolean }) {
  const { data, error } = useApi<{ timezones: string[] }>("/api/system/time", {
    revalidateOnFocus: false,
  });
  const zones = data?.timezones ?? [];

  if (!data && !error) return <Skeleton height={34} width={280} radius={7} />;
  if (error || zones.length === 0) {
    return (
      <span className={s.sub}>
        <span className="mono">{value ?? "Unknown"}</span> · the list of timezones couldn't be loaded.
      </span>
    );
  }

  return (
    <Combobox.Root<string>
      items={zones}
      value={value}
      onValueChange={(v) => {
        if (typeof v === "string" && v && v !== value) onChange(v);
      }}
      itemToStringLabel={label}
      autoHighlight
      openOnInputClick
      limit={1000}
      disabled={disabled}
    >
      <Combobox.InputGroup className={s.comboGroup}>
        <Combobox.Input className={s.comboInput} placeholder="Search, e.g. Chicago or Europe" aria-label="Timezone" spellCheck={false} />
        <Combobox.Trigger className={s.comboTrigger} aria-label="Show timezones">
          <NavArrowDown strokeWidth={2} />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className={p.positioner} sideOffset={6} align="start">
          <Combobox.Popup className={`${p.popup} ${s.comboPopup}`}>
            <Combobox.Empty>
              <div className={s.comboEmpty}>No timezone matches. Try a city or region name.</div>
            </Combobox.Empty>
            <Combobox.List>
              {(tz: string) => (
                <Combobox.Item key={tz} value={tz} className={p.item}>
                  <span className={s.comboItemText}>{label(tz)}</span>
                  <Combobox.ItemIndicator className={p.check}>
                    <Check strokeWidth={2.2} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
