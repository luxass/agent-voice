import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { soxBackend } from "../src/backends";
import { createRecorder } from "../src/recording";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const out = process.argv[process.argv.length - 1];
if (process.env.STUB_SOX_ARGV_FILE) fs.writeFileSync(process.env.STUB_SOX_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.STUB_SOX_MODE === "exit1") {
  process.stderr.write("first line\\nsox FAIL: no such device\\n");
  process.exit(2);
}
fs.writeFileSync(out, Buffer.alloc(100));
if (process.env.STUB_SOX_MODE === "hang") {
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
} else {
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;

let dir: string | undefined;
let stub: string;

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), "agent-voice-rec-"));
  stub = join(dir, "sox");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  return stub;
}

afterEach(() => {
  delete process.env.STUB_SOX_MODE;
  delete process.env.STUB_SOX_ARGV_FILE;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("createRecorder", () => {
  it("starts and stops, returning a file the caller owns", async () => {
    const sox = setup();
    const argvFile = join(dir as string, "argv.json");
    process.env.STUB_SOX_ARGV_FILE = argvFile;
    const onError = vi.fn();
    const recorder = createRecorder({ backend: soxBackend(sox), onError });
    expect(recorder.isRecording).toBe(false);
    recorder.start();
    expect(recorder.isRecording).toBe(true);
    // Wait until the stub has booted (and written its output file) so the
    // stop signal cannot race process startup.
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true));
    const file = await recorder.stop();
    expect(recorder.isRecording).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    recorder.discard(file);
    expect(existsSync(file)).toBe(false);
  });

  it("passes the input device through to sox", async () => {
    const sox = setup();
    const argvFile = join(dir as string, "argv.json");
    process.env.STUB_SOX_ARGV_FILE = argvFile;
    const recorder = createRecorder({ backend: soxBackend(sox), onError: () => {} });
    recorder.start({ id: "coreaudio:Mic", name: "Mic", format: "coreaudio", source: "Mic" });
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true));
    const file = await recorder.stop();
    recorder.discard(file);
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv.slice(0, 3)).toEqual(["-t", "coreaudio", "Mic"]);
    expect(argv).toContain("-r");
  });

  it("uses the system default input without a device", async () => {
    const sox = setup();
    const argvFile = join(dir as string, "argv.json");
    process.env.STUB_SOX_ARGV_FILE = argvFile;
    const recorder = createRecorder({ backend: soxBackend(sox), onError: () => {} });
    recorder.start();
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true));
    const file = await recorder.stop();
    recorder.discard(file);
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv[0]).toBe("-d");
  });

  it("throws when starting twice", () => {
    const recorder = createRecorder({ backend: soxBackend(setup()), onError: () => {} });
    recorder.start();
    expect(() => recorder.start()).toThrow("Already recording");
    recorder.cancel();
  });

  it("throws when stopping without a recording", async () => {
    const recorder = createRecorder({ backend: soxBackend(setup()), onError: () => {} });
    await expect(recorder.stop()).rejects.toThrow("No recording in progress");
  });

  it("reports background death with the last stderr line", async () => {
    const onError = vi.fn();
    const recorder = createRecorder({ backend: soxBackend(setup()), onError });
    process.env.STUB_SOX_MODE = "exit1";
    recorder.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(recorder.isRecording).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "sox FAIL: no such device" });
  });

  it("reports a missing sox binary through onError", async () => {
    const onError = vi.fn();
    const recorder = createRecorder({ backend: soxBackend("/does/not/exist-sox"), onError });
    recorder.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(recorder.isRecording).toBe(false);
  });

  it("kills and rejects when the recorder ignores SIGINT", async () => {
    process.env.STUB_SOX_MODE = "hang";
    const sox = setup();
    const argvFile = join(dir as string, "argv.json");
    process.env.STUB_SOX_ARGV_FILE = argvFile;
    const recorder = createRecorder({ backend: soxBackend(sox), onError: () => {} });
    recorder.start();
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true));
    await expect(recorder.stop()).rejects.toThrow("Recorder did not stop in time");
    expect(recorder.isRecording).toBe(false);
  }, 10_000);

  it("cancel kills the process, deletes the file, and is safe when idle", async () => {
    const sox = setup();
    const argvFile = join(dir as string, "argv.json");
    process.env.STUB_SOX_ARGV_FILE = argvFile;
    const recorder = createRecorder({ backend: soxBackend(sox), onError: () => {} });
    recorder.cancel();
    recorder.start();
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true));
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    const path = argv[argv.length - 1] as string;
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    recorder.cancel();
    expect(recorder.isRecording).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("discard never throws, even for missing files", () => {
    const recorder = createRecorder({ backend: soxBackend(setup()), onError: () => {} });
    expect(() => recorder.discard("/does/not/exist.wav")).not.toThrow();
  });
});
