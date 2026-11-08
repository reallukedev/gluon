"use client";
import * as React from "react";
import { PageHeader } from "@/components/ui/Surface";

interface SectionMeta {
  title: string;
  back: { href: string; label: string };
}

const Ctx = React.createContext<SectionMeta | null>(null);

export function SectionHeaderProvider({ value, children }: { value: SectionMeta; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** There is still exactly one page header on the page: the section supplies its summary and actions. */
export function SectionHeader({ summary, actions }: { summary: React.ReactNode; actions?: React.ReactNode }) {
  const meta = React.useContext(Ctx);
  if (!meta) throw new Error("SectionHeader must be rendered inside a Settings section.");
  return <PageHeader title={meta.title} summary={summary} actions={actions} back={meta.back} />;
}
