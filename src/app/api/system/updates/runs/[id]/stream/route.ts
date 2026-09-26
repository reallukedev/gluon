import { route, sse } from "@/server/api";
import { notFound } from "@/server/errors";
import { subscribe } from "@/server/events";
import { follow, getRun, runBuffer, runTopic, type RunEvent } from "@/server/system/apt-runner";

/**
 * Live output of an update run.
 * Events: `snapshot` { run, lines, from } → `line` { n, text }… → `done` { run }.
 * Finished runs send snapshot + done immediately. Dedupe lines by `n` after reconnecting.
 */
export const GET = route({ auth: "admin" }, ({ req, params }) => {
  const id = String(params.id);
  const run = getRun(id);
  if (!run) throw notFound("That update run");
  return sse(req, (send, close) => {
    const { log, ...summary } = run;
    if (summary.outcome !== "running") {
      send("snapshot", { run: summary, lines: log ? log.split("\n") : [], from: 0 });
      send("done", { run: summary });
      close();
      return;
    }
    follow(id);
    const buf = runBuffer(id) ?? { lines: [], from: 0 };
    send("snapshot", { run: summary, lines: buf.lines, from: buf.from });
    return subscribe(runTopic(id), (d) => {
      const e = d as RunEvent;
      if (e.type === "line") send("line", { n: e.n, text: e.text });
      else {
        send("done", { run: e.run });
        close();
      }
    });
  });
});
