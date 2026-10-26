"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Surface";
import s from "./builder.module.css";

// CodeMirror (with lint and merge) only loads when an editor is actually on screen.
const Editor = dynamic(() => import("./YamlEditor").then((m) => m.YamlEditor), {
  ssr: false,
  loading: () => <Skeleton height="var(--editor-height)" radius={0} />,
});

type Props = React.ComponentProps<typeof Editor>;

/** YamlEditor, loaded on demand, holding its own height while it loads so nothing jumps. */
export function LazyYamlEditor(props: Props) {
  const h = props.height ?? 520;
  return (
    <div className={s.lazyEditor} style={{ "--editor-height": typeof h === "number" ? `${h}px` : h } as React.CSSProperties}>
      <Editor {...props} />
    </div>
  );
}
