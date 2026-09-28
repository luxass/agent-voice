import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { metadata } from "vitest-testdirs/helpers";

import { createRecorder } from "../src/recording";

/**
 * A fake sox: records its argv next to itself, writes 100 bytes to the output file,
 * then runs until `onSigint` handles the stop signal. Node runs it as ESM or CommonJS
 * depending on the nearest package.json, so it avoids `require` and `import`.
 */
const recordingSox = (onSigint = "process.exit(0)") =>
  metadata(
    `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
fs.writeFileSync(path.join(path.dirname(process.argv[1]), "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.argv.at(-1), Buffer.alloc(100));
process.on("SIGINT", () => { ${onSigint} });
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );

const failingSox = metadata(
  `#!/usr/bin/env node
process.stderr.write("first line\\nsox FAIL: no such device\\n");
process.exit(2);
`,
  { mode: 0o755 },
);

/** A recorder using a fake sox on `PATH`. `started()` resolves with sox's argv once it is running. */
async function fixture(sox = recordingSox()) {
  const dir = await testdir({ sox });
  vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
  const recorder = createRecorder();
  onTestFinished(() => {
    recorder.cancel();
  });
  const started = () =>
    vi.waitFor(() => JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[]);
  return { recorder, started };
}

const MIC = { id: "coreaudio:Mic", name: "Mic", format: "coreaudio", source: "Mic" } as const;

describe("createRecorder", () => {
  it("starts and stops, returning a file the caller owns", async () => {
    const { recorder, started } = await fixture();
    const onError = vi.fn<(error: Error) => void>();
    expect(recorder.isRecording).toBe(false);
    recorder.start(undefined, onError);
    expect(recorder.isRecording).toBe(true);
    // Wait for sox to boot so the stop signal cannot race process startup.
    await started();

    const file = await recorder.stop();
    expect(recorder.isRecording).toBe(false);
    expect(readFileSync(file)).toHaveLength(100);
    expect(onError).not.toHaveBeenCalled();

    recorder.discard(file);
    expect(existsSync(file)).toBe(false);
  });

  it("records 16kHz mono 16-bit audio from the given device", async () => {
    const { recorder, started } = await fixture();
    recorder.start(MIC, () => {});
    const argv = await started();
    const file = await recorder.stop();
    recorder.discard(file);
    expect(argv).toEqual(["-t", "coreaudio", "Mic", "-r", "16000", "-c", "1", "-b", "16", file]);
  });

  it("uses the system default input without a device", async () => {
    const { recorder, started } = await fixture();
    recorder.start(undefined, () => {});
    const argv = await started();
    expect(argv[0]).toBe("-d");
  });

  it("throws when starting twice", async () => {
    const { recorder } = await fixture();
    recorder.start(undefined, () => {});
    expect(() => {
      recorder.start(undefined, () => {});
    }).toThrow("Already recording");
  });

  it("throws when stopping without a recording", async () => {
    const { recorder } = await fixture();
    await expect(recorder.stop()).rejects.toThrow("No recording in progress");
  });

  it("reports background death once, with the last stderr line", async () => {
    const { recorder } = await fixture(failingSox);
    const onError = vi.fn<(error: Error) => void>();
    recorder.start(undefined, onError);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(recorder.isRecording).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "sox FAIL: no such device" });
  });

  it("reports a missing sox binary through onError", async () => {
    vi.stubEnv("PATH", await testdir({}));
    const recorder = createRecorder();
    const onError = vi.fn<(error: Error) => void>();
    recorder.start(undefined, onError);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "ENOENT" });
    expect(recorder.isRecording).toBe(false);
  });

  it("kills sox, deletes the file and rejects when SIGINT is ignored", async () => {
    const { recorder, started } = await fixture(recordingSox(""));
    recorder.start(undefined, () => {});
    const file = (await started()).at(-1) as string;
    await expect(recorder.stop()).rejects.toThrow("Recorder did not stop in time");
    expect(recorder.isRecording).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("cancel kills the process, deletes the file, and is safe when idle", async () => {
    const { recorder, started } = await fixture();
    recorder.cancel();
    recorder.start(undefined, () => {});
    const file = (await started()).at(-1) as string;
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
    });
    recorder.cancel();
    expect(recorder.isRecording).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("discard ignores missing files", async () => {
    const { recorder } = await fixture();
    expect(() => {
      recorder.discard("/does/not/exist.wav");
    }).not.toThrow();
  });
});
