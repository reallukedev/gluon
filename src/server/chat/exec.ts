import "server-only";
import { docker } from "../docker/client";
import { dockerError } from "../dockerx/core";

/**
 * Run a command in a container with something on its standard input, and collect what it prints.
 * Used to feed prosodyctl's console.
 */
export async function execWithInput(
  containerId: string,
  argv: string[],
  input: string,
  opts: { user?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const ctr = docker().getContainer(containerId);
  let exec: Awaited<ReturnType<typeof ctr.exec>>;
  try {
    exec = await ctr.exec({ Cmd: argv, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, User: opts.user, Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined });
  } catch (e) {
    throw dockerError(e, "Couldn't reach the chat server");
  }
  const stream = (await exec.start({ hijack: true, stdin: true })) as NodeJS.ReadWriteStream;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const sink = (into: Buffer[]) => ({ write: (c: Buffer) => (into.push(Buffer.from(c)), true) }) as unknown as NodeJS.WritableStream;
  docker().modem.demuxStream(stream, sink(out), sink(err));

  let timedOut = false;
  const done = new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", () => resolve());
  });
  const timer = setTimeout(() => {
    timedOut = true;
    (stream as unknown as { destroy?: () => void }).destroy?.();
    // Closing the stream doesn't stop the process. Gluon shares the host's process table in
    // production, so it can end it directly.
    void exec
      .inspect()
      .then((st) => {
        if (st.Running && st.Pid) process.kill(st.Pid, "SIGKILL");
      })
      .catch(() => undefined);
  }, opts.timeoutMs ?? 20_000);

  stream.write(input.endsWith("\n") ? input : `${input}\n`);
  // Half-close: prosodyctl sees the end of its input and exits once it has answered.
  stream.end();
  await done;
  clearTimeout(timer);

  let exitCode: number | null = null;
  try {
    exitCode = (await exec.inspect()).ExitCode ?? null;
  } catch {
    /* the exec is gone; the output is what matters */
  }
  return { exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut };
}
