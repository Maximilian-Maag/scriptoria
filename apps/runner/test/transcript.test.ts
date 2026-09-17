import { describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_BYTES, Transcript } from "../src/run/transcript";

describe("Transcript", () => {
  it("keeps the bytes exactly as they arrived", () => {
    const transcript = new Transcript();
    // A multi-byte sequence split across two PTY reads is the normal case, not
    // an edge case (ADR-006). Nothing here may decode it.
    transcript.append(Buffer.from([0xc3]));
    transcript.append(Buffer.from([0xa4]));

    expect(Buffer.from(transcript.toBase64(), "base64").toString("utf8")).toBe("ä");
    expect(transcript.sizeBytes).toBe(2);
    expect(transcript.truncated).toBe(false);
  });

  it("ignores an empty chunk", () => {
    const transcript = new Transcript();
    transcript.append(Buffer.alloc(0));
    expect(transcript.sizeBytes).toBe(0);
  });

  it("keeps the tail when a run outruns the ceiling", () => {
    const transcript = new Transcript();
    const chunk = Buffer.alloc(1024 * 1024, "a");
    for (let i = 0; i < 12; i++) transcript.append(chunk);

    // The end of a run is what somebody reading it afterwards is looking for:
    // the last prompt, the last error, the summary line.
    expect(transcript.truncated).toBe(true);
    expect(transcript.sizeBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  });
});
