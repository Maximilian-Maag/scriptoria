/**
 * FA-07.2 / ADR-006 — the durable copy of a run's terminal.
 *
 * The Redis stream is capped and expires; this is what the console loads when
 * somebody opens a run that finished last week. It accumulates in memory during
 * the run and is written once when the run ends, because a run is minutes long
 * and a row rewritten per PTY chunk would be a row rewritten thousands of times.
 *
 * Nothing here decodes anything either. The bytes are kept as bytes and encoded
 * to base64 at the end (ADR-006).
 */

/**
 * The ceiling. A run that writes more than this keeps its tail, because the end
 * of a run is what somebody reading it afterwards is looking for: the last
 * prompt, the last error, the summary line.
 */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export class Transcript {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;

    while (this.size > MAX_TRANSCRIPT_BYTES && this.chunks.length > 1) {
      const head = this.chunks.shift();
      this.size -= head?.length ?? 0;
      this.dropped = true;
    }
  }

  /** True when the head was dropped and the history does not start at the start. */
  get truncated(): boolean {
    return this.dropped;
  }

  get sizeBytes(): number {
    return this.size;
  }

  toBase64(): string {
    return Buffer.concat(this.chunks).toString("base64");
  }
}
