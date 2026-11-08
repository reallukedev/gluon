"use client";
import { Tray } from "./Tray";
import { useUploads } from "./uploads";

const noop = () => undefined;

export default function UploadsElsewhere() {
  const list = useUploads();
  if (!list.length) return null;
  return <Tray jobs={[]} onCancelJob={noop} onUndo={noop} onClearJobs={noop} />;
}
