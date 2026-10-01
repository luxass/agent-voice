import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InputDevice } from "./devices";

export type Recorder = {
  /** Whether a recording is currently in progress. */
  readonly isRecording: boolean;
  /**
   * Start recording from `input`, or the system default. Throws if already recording.
   * `onError` fires if the recording fails in the background (e.g. the device disappears).
   */
  start: (input: InputDevice | undefined, onError: (error: Error) => void) => void;
  /** Stop recording and return the WAV file path. The caller owns the file; delete it with `discard`. */
  stop: () => Promise<string>;
  /** Abort the in-progress recording, if any, and delete its file. Safe to call when idle. */
  cancel: () => void;
  /** Delete a file previously returned by `stop()`. Best-effort; never throws. */
  discard: (file: string) => void;
};

const STOP_TIMEOUT_MS = 2000;

type Recording = { child: ChildProcess; file: string };

/** Best-effort delete; never throws. */
function discard(file: string): void {
  rmSync(file, { force: true });
}

/** SoX args that record from `input` (system default when `undefined`) into `file`. */
function soxArgs(input: InputDevice | undefined, file: string): string[] {
  return [
    ...(input ? ["-t", input.format, input.source] : ["-d"]),
    // Whisper expects 16kHz mono 16-bit audio.
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    file,
  ];
}

/** The last stderr line, or `fallback` when stderr is blank. */
function lastLine(stderr: string, fallback: string): string {
  const line = stderr.trim().split("\n").pop();
  return line == null || line === "" ? fallback : line;
}

/** Spawn SoX into `file`. `onFailure` gets spawn errors, or the last stderr line if it exits. */
function spawnSox(
  input: InputDevice | undefined,
  file: string,
  onFailure: (error: Error) => void,
): ChildProcess {
  const child = spawn("sox", soxArgs(input, file), { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", onFailure);
  child.on("exit", (code) => {
    onFailure(new Error(lastLine(stderr, `Recorder exited (${code})`)));
  });
  return child;
}

/** SIGINT makes SoX finalize its WAV; SIGKILL it if that takes too long. */
function interrupt(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Recorder did not stop in time"));
    }, STOP_TIMEOUT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`Recorder exited (${code ?? signal})`));
    });
    child.kill("SIGINT");
  });
}

/** Record with `sox`, resolved via `PATH`. */
export function createRecorder(): Recorder {
  let active: Recording | undefined;

  /** Detach and forget the active recording, so late events have no listener to fire. */
  function release(): Recording | undefined {
    const current = active;
    active = undefined;
    current?.child.removeAllListeners();
    return current;
  }

  function start(input: InputDevice | undefined, onError: (error: Error) => void): void {
    if (active) throw new Error("Already recording");
    const file = join(tmpdir(), `agent-voice-${randomUUID()}.wav`);
    // Releasing first also stops the paired `error`/`exit` event from reporting twice.
    const child = spawnSox(input, file, (error) => {
      release();
      discard(file);
      onError(error);
    });
    active = { child, file };
  }

  async function stop(): Promise<string> {
    const current = release();
    if (!current) throw new Error("No recording in progress");
    await interrupt(current.child).catch((error: unknown) => {
      discard(current.file);
      throw error;
    });
    return current.file;
  }

  function cancel(): void {
    const current = release();
    if (!current) return;
    current.child.kill("SIGKILL");
    discard(current.file);
  }

  return {
    get isRecording() {
      return active != null;
    },
    start,
    stop,
    cancel,
    discard,
  };
}
