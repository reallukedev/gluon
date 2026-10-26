"use client";
import { api, ApiError, streamPost } from "@/lib/client/api";
import type { TargetId, TermEvent } from "@/lib/terminal/types";

export interface SessionHandlers {
  onOpen?: (e: Extract<TermEvent, { type: "open" }>) => void;
  onOut: (data: string) => void;
  onExit: (e: Extract<TermEvent, { type: "exit" }>) => void;
  onError: (message: string, code?: string) => void;
}

export interface SessionStart {
  target: TargetId;
  mode: "run" | "shell";
  command?: string;
  cwd?: string | null;
  rows: number;
  cols: number;
}

/**
 * One running command or terminal: its output arrives on a streamed POST; keystrokes, resizes and
 * Stop go out as small POSTs, in order, with typing batched so a fast typist isn't a request storm.
 */
export class LiveSession {
  id: string | null = null;
  private abort = new AbortController();
  private queue = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingResize: { rows: number; cols: number } | null = null;
  private ended = false;
  readonly done: Promise<void>;

  constructor(start: SessionStart, h: SessionHandlers) {
    this.done = streamPost<TermEvent>(
      "/api/terminal/sessions",
      start,
      (e) => {
        if (e.type === "open") {
          this.id = e.id;
          h.onOpen?.(e);
          if (this.queue) this.flush();
          if (this.pendingResize) this.resize(this.pendingResize.rows, this.pendingResize.cols);
        } else if (e.type === "out") h.onOut(e.data);
        else if (e.type === "exit") {
          this.ended = true;
          h.onExit(e);
        } else if (e.type === "error") h.onError(e.message);
      },
      this.abort.signal,
    ).then(
      () => {
        if (!this.ended) {
          this.ended = true;
          h.onError("The connection to the server dropped, so this was stopped.", "dropped");
        }
      },
      (err: unknown) => {
        this.ended = true;
        if (this.abort.signal.aborted) h.onError("Stopped before it started.", "aborted");
        else if (err instanceof ApiError) h.onError(err.message, err.code);
        else h.onError("Can't reach the server. Check your connection and try again.", "network");
      },
    );
  }

  get running() {
    return !this.ended;
  }

  send(data: string) {
    if (this.ended || !data) return;
    this.queue += data;
    if (!this.id) return;
    this.timer ??= setTimeout(() => this.flush(), 8);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.id || !this.queue) return;
    const input = this.queue;
    this.queue = "";
    this.post({ input });
  }

  resize(rows: number, cols: number) {
    if (this.ended) return;
    if (!this.id) {
      this.pendingResize = { rows, cols };
      return;
    }
    this.pendingResize = null;
    this.post({ resize: { rows, cols } });
  }

  /** Ctrl-C, then harder until it's gone. */
  stop() {
    if (this.ended || !this.id) {
      this.close();
      return Promise.resolve();
    }
    this.flush();
    return this.post({ stop: true });
  }

  /** Drop the stream; the server ends whatever is running. */
  close() {
    this.ended = true;
    this.abort.abort();
  }

  private post(body: unknown) {
    const id = this.id;
    this.chain = this.chain.then(() => api.post(`/api/terminal/sessions/${encodeURIComponent(id!)}`, body).catch(() => undefined));
    return this.chain as Promise<void>;
  }
}
