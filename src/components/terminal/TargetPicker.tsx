"use client";
import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, NavArrowDown, Server } from "iconoir-react";
import type { TargetId, TargetList, TargetOption } from "@/lib/terminal/types";
import { AppIcon } from "@/components/apps/AppIcon";
import { StateLine } from "@/components/ui/StateLine";
import p from "@/components/ui/popup.module.css";
import s from "./terminal.module.css";

interface Item {
  id: TargetId;
  name: string;
  group: string;
  icon: string | null;
  option: TargetOption | null;
}

interface Group {
  value: string;
  icon: string | null;
  items: Item[];
}

/** Where commands run: This server, or any container, grouped by app and searchable. */
export function TargetPicker({ list, value, onChange, hostName }: { list: TargetList | undefined; value: TargetId; onChange: (t: TargetId) => void; hostName: string }) {
  const groups = React.useMemo<Group[]>(() => {
    const out: Group[] = [{ value: "Server", icon: null, items: [{ id: "host", name: "This server", group: "Server", icon: null, option: null }] }];
    for (const g of list?.groups ?? []) out.push({ value: g.name, icon: g.icon, items: g.targets.map((t) => ({ id: t.id, name: t.name, group: g.name, icon: g.icon, option: t })) });
    return out;
  }, [list]);
  const all = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = all.find((i) => i.id === value) ?? (value === "host" ? all[0]! : { id: value, name: value.replace(/^container:/, ""), group: "", icon: null, option: null });
  const hostBlocked = list && !list.host.available ? list.host.note : null;

  return (
    <Combobox.Root<Item>
      items={groups}
      value={current}
      onValueChange={(v) => {
        if (v && v.id !== value) onChange(v.id);
      }}
      itemToStringLabel={(i) => i.name}
      itemToStringValue={(i) => i.id}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(item, query) => {
        const q = query.trim().toLowerCase();
        return !q || item.name.toLowerCase().includes(q) || item.group.toLowerCase().includes(q) || (item.id === "host" && hostName.toLowerCase().includes(q));
      }}
      autoHighlight
    >
      <Combobox.Trigger className={s.pickTrigger} aria-label={`Run commands in: ${current.id === "host" ? "this server" : current.name}. Change`}>
        <span className={s.pickIcon} aria-hidden>
          {current.id === "host" ? <Server strokeWidth={1.6} /> : <AppIcon src={current.icon} name={current.group || current.name} size={20} />}
        </span>
        <span className={s.pickText}>
          <span className={s.pickName}>{current.id === "host" ? "This server" : current.name}</span>
          <span className={s.pickSub}>{current.id === "host" ? hostName : current.group}</span>
        </span>
        <NavArrowDown className={s.pickChevron} strokeWidth={2} aria-hidden />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className={p.positioner} sideOffset={6} align="end" collisionPadding={8}>
          <Combobox.Popup className={`${p.popup} ${s.pickPopup}`} aria-label="Where to run commands">
            <div className={s.pickSearch}>
              <Combobox.Input className={s.pickInput} placeholder="Find a container or app" aria-label="Find a container or app" spellCheck={false} autoComplete="off" />
            </div>
            <Combobox.Empty>
              <div className={s.pickEmpty}>Nothing by that name. Stopped containers are listed too, under their app.</div>
            </Combobox.Empty>
            <Combobox.List className={s.pickList}>
              {(g: Group) => (
                <Combobox.Group key={g.value} items={g.items} className={s.pickGroup}>
                  <Combobox.GroupLabel className={`label ${p.groupLabel} ${s.pickGroupLabel}`}>
                    {g.value === "Server" ? null : <AppIcon src={g.icon} name={g.value} size={16} />}
                    <span>{g.value}</span>
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(i: Item) => {
                      const blocked = i.id === "host" ? hostBlocked : (i.option?.blocked ?? null);
                      return (
                        <Combobox.Item key={i.id} value={i} disabled={!!blocked} className={`${p.item} ${s.pickItem}`}>
                          {i.id === "host" ? <Server strokeWidth={1.6} /> : <StateLine state={i.option?.line ?? "unknown"} />}
                          <span className={s.pickItemText}>
                            <span className={s.pickItemName}>{i.id === "host" ? `This server (${hostName})` : i.name}</span>
                            {blocked && <span className={s.pickItemWhy}>{blocked}</span>}
                          </span>
                          <Combobox.ItemIndicator className={p.check}>
                            <Check strokeWidth={2.2} />
                          </Combobox.ItemIndicator>
                        </Combobox.Item>
                      );
                    }}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
