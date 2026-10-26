import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { listJobs } from "@/server/files/jobs";
import type { FileJob } from "@/lib/files-types";

/**
 * Live file tasks. Events: "snapshot" FileJob[] once, then "job" FileJob on every change,
 * plus "upload" (UploadSession), "trash" ({ id, change }) and "size" ({ path, bytes }).
 */
export const GET = route({ auth: "user" }, ({ req, user }) =>
  sse(req, (send) => {
    send("snapshot", listJobs(user, 20));
    const mine = (j: FileJob) => user.role === "admin" || j.userId === user.id;
    const offs = [
      subscribe("files.jobs", (d) => {
        if (mine(d as FileJob)) send("job", d);
      }),
      subscribe("files.uploads", (d) => {
        const u = d as { userId: string; upload: unknown };
        if (u.userId === user.id) send("upload", u.upload);
      }),
      subscribe("files.trash", (d) => send("trash", d)),
    ];
    if (user.role === "admin") offs.push(subscribe("files.size", (d) => send("size", d)));
    return () => offs.forEach((o) => o());
  }),
);
