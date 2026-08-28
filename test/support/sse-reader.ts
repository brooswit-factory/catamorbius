/** Minimal reader shape we need — sidesteps the ambient ReadableStream typings, which vary by lib config. */
interface MinimalStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** Hand-rolled raw SSE frame reader for unit tests — reads exact bytes off a Response body, one "\n\n"-delimited frame at a time. */
export class SseReader {
  private reader: MinimalStreamReader;
  private buffer = "";
  private decoder = new TextDecoder();
  // A read() left pending after a timed-out nextRaw() must be reused, not abandoned — the
  // stream fulfills read() calls in FIFO order, so issuing a fresh one would let a later
  // chunk answer the abandoned call instead of the one the caller is actually waiting on.
  private pendingRead: Promise<{ done: boolean; value?: Uint8Array }> | null = null;

  constructor(res: Response) {
    if (!res.body) throw new Error("response has no body");
    this.reader = (res.body as unknown as { getReader(): MinimalStreamReader }).getReader();
  }

  /** Returns the next frame's raw text with the trailing "\n\n" stripped. */
  async nextRaw(timeoutMs = 2000): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx !== -1) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return raw;
      }
      if (!this.pendingRead) this.pendingRead = this.reader.read();
      const { value, done } = await withTimeout(this.pendingRead, timeoutMs);
      this.pendingRead = null;
      if (done) throw new Error("stream ended before a full frame arrived");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for SSE data after ${ms}ms`)), ms)),
  ]);
}
