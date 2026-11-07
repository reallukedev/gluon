"use client";
// Every open problem on admins' Home, worst first, each with its fix and a way to put it off. Links to a
// problem (alerts, search, monitors, the status hero) land here by its id.
import * as React from "react";
import { registerWidget } from "../widgetStore";
import type { WidgetProps } from "../types";
import type { StatusPayload } from "@/server/status";
import { useApi, STATUS_KEY, STATUS_REFRESH } from "@/lib/client/api";
import { NeedsYou } from "@/components/status/NeedsYou";
import { Time } from "@/components/ui/Time";
import { WidgetState } from "./kit";
import { Preview } from "../previews";
import w from "./problems.module.css";

function ProblemsWidget(_: WidgetProps) {
  const { data, error, mutate } = useApi<StatusPayload>(STATUS_KEY, { refresh: STATUS_REFRESH });
  if (!data && error) return <WidgetState line="unknown" title="Can't check the server">{error.message}</WidgetState>;
  if (!data) return <div className={w.body} aria-busy />;
  if (!data.findings.length)
    return (
      <WidgetState line="running" title="Nothing needs you">
        Checked <Time ts={data.checkedAt} kind="time" />
      </WidgetState>
    );
  return (
    <div className={w.body}>
      <NeedsYou findings={data.findings} onChange={() => void mutate()} checkedAt={data.checkedAt} foot={null} />
    </div>
  );
}

registerWidget({
  type: "problems",
  name: "Needs you",
  description: "Every open problem, worst first, with its fix and a way to put it off.",
  category: "Server",
  sizes: ["m", "t", "l", "w"],
  defaultSize: "w",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Needs you",
  Component: ProblemsWidget,
  preview: <Preview of="status" />,
});
