"use client";
import * as React from "react";
import { PageHeader } from "@/components/ui/Surface";

interface SectionMeta {
  title: string;
  back: { href: string; label: string };
}

const Ctx = React.createContext<SectionMeta | null>(null);

/** Set by SettingsView around a section that states its own header (see `ownHeader` in sections.ts). */
export function SectionHeaderProvider({ value, children }: { value: SectionMeta; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The page header of a Settings section that knows its own state: the title and back link come from
 * Settings, the section supplies the one-sentence summary and its actions. There is still exactly one
 * page header on the page.
 */
export function SectionHeader({ summary, actions }: { summary: React.ReactNode; actions?: React.ReactNode }) {
  const meta = React.useContext(Ctx);
  if (!meta) throw new Error("SectionHeader must be rendered inside a Settings section.");
  return <PageHeader title={meta.title} summary={summary} actions={actions} back={meta.back} />;
}
