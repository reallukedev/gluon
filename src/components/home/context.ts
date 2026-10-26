"use client";
import * as React from "react";

export type CollectionSection = "apps" | "folders" | "widgets" | "from-apps";

/** What Home offers the things on it: open the Collection (at a section), and whether it's being arranged. */
export interface HomeContextValue {
  openCollection: (section?: CollectionSection) => void;
  arranging: boolean;
  /** Whether a kind of item is on this Home (the greeting leaves the date to a clock). */
  pinned: (type: string) => boolean;
  /** The status hero is on Home at a size that shows its fix button, so app cards leave the fix to it. */
  heroFix: boolean;
}

export const HomeContext = React.createContext<HomeContextValue>({ openCollection: () => undefined, arranging: false, pinned: () => false, heroFix: false });
export const useHome = () => React.useContext(HomeContext);
