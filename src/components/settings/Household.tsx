"use client";
import * as React from "react";
import { api, useApi } from "@/lib/client/api";
import { HOUSEHOLD_DEFAULT, SIZES, type HomeLayout } from "@/lib/home";
import { allWidgets } from "@/components/home/registry";
import { Panel, Skeleton } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import s from "./settings.module.css";

export function Household() {
  const { data, mutate } = useApi<HomeLayout>("/api/home/default");
  const [confirm, confirmNode] = useConfirm();
  const defs = allWidgets();
  return (
    <div className={s.stack}>
      <Panel title="Default home page">
        <p className={s.hint} style={{ marginBottom: 14 }}>
          New household members start with this layout. Anyone can change their own afterwards; changing the default doesn't touch pages people have already customised.
        </p>
        {!data ? (
          <Skeleton height={120} />
        ) : (
          <ol className={s.layoutMap} aria-label="The default home page, as a map">
            {data.items.map((i) => {
              const d = defs.find((x) => x.type === i.type);
              const size = SIZES[i.size];
              return (
                <li
                  key={i.id}
                  className={s.layoutTile}
                  data-admin={d?.adminOnly ? "" : undefined}
                  style={{ gridColumn: `span ${size.cols}`, gridRow: `span ${size.rows}` }}
                  title={`${d?.name ?? i.type} · ${size.label}${d?.adminOnly ? " · admins only, hidden from members" : ""}`}
                >
                  <span className="truncate">{d?.name ?? i.type}</span>
                  <small className="truncate">{d?.adminOnly ? "Admins only" : size.label}</small>
                </li>
              );
            })}
          </ol>
        )}
        <div className={s.actions} style={{ marginTop: 14 }}>
          <Button
            variant="ghost"
            onClick={() =>
              confirm({
                title: "Go back to Gluon's default?",
                consequences: ["New members will start with a clock, status, apps, links and notes."],
                confirmLabel: "Reset",
                variant: "primary",
                onConfirm: async () => {
                  await api.put("/api/home/default", { layout: HOUSEHOLD_DEFAULT });
                  void mutate();
                  toast.success("Default reset");
                },
              })
            }
          >
            Reset to Gluon's default
          </Button>
          <LinkButton href="/?edit=1" variant="primary">
            Design it on your home page
          </LinkButton>
        </div>
        <p className={s.hint} style={{ marginTop: 10 }}>
          Arrange your own home page, then choose <b>More → Make this the household default</b>.
        </p>
      </Panel>
      {confirmNode}
    </div>
  );
}
