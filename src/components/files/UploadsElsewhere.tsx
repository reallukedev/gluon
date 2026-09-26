"use client";
import { Tray } from "./Tray";
import { useUploads } from "./uploads";

const noop = () => undefined;

/** Keeps the uploads tray on screen when someone leaves Files mid-upload. Tasks stay on the Files page. */
export default function UploadsElsewhere() {
  const list = useUploads();
  if (!list.length) return null;
  return <Tray jobs={[]} onCancelJob={noop} onUndo={noop} onClearJobs={noop} />;
}
