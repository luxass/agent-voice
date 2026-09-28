import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureBackend } from "./backends";
import { soxBackend } from "./backends";
import type { InputDevice } from "./devices";

export type RecorderOptions = {
  /** Capture backend. Defaults to SoX resolved via `PATH`. */
  backend?: CaptureBackend;
  /** Called when recording fails in the background (e.g. the device disappears mid-recording). */
  onError: (error: Error) => void;
};

export type Recorder = {
  /** Whether a recording is currently in progress. */
  readonly isRecording: boolean;
  /** Start recording from `input`, or the system default. Throws if already recording. */
  start: (input?: InputDevice) => void;
  /** Stop recording and return the WAV file path. The caller owns the file; delete it with `discard`. */
  stop: () => Promise<string>;
  /** Abort the in-progress recording, if any, and delete its file. Safe to call when idle. */
  cancel: () => void;
  /** Delete a file previously returned by `stop()`. Best-effort; never throws. */
  discard: (file: string) => void;
};

const STOP_TIMEOUT_MS = 2000;

function removeFile(path: string): void {
  rmSync(path, { force: true });
}

export function createRecorder(options: RecorderOptions): Recorder {
  const backend = options.backend ?? soxBackend();
  const { onError } = options;
  let child: ChildProcess | undefined;
  let file: string | undefined;

  function fail(current: ChildProcess, path: string, error: Error): void {
    // Detach first so the paired `error`/`exit` event cannot report twice,
    // and so late events after `stop()`/`cancel()` have no listener to fire.
    current.removeAllListeners();
    child = undefined;
    file = undefined;
    rmSync(path, { force: true });
    onError(error);
  }

  function start(input?: InputDevice): void {
    if (child) throw new Error("Already recording");
    const path = join(tmpdir(), `agent-voice-${randomUUID()}.wav`);
    const current = spawn(backend.command, backend.args(input, path), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = current;
    file = path;
    let stderr = "";
    current.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    current.on("error", (error) => {
      fail(current, path, error);
    });
    current.on("exit", (code) => {
      fail(
        current,
        path,
        new Error(stderr.trim().split("\n").pop() || `Recorder exited (${code})`),
      );
    });
  }

  async function stop(): Promise<string> {
    const current = child;
    const path = file;
    if (!current || !path) throw new Error("No recording in progress");
    child = undefined;
    file = undefined;
    current.removeAllListeners();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          current.kill("SIGKILL");
          reject(new Error("Recorder did not stop in time"));
        }, STOP_TIMEOUT_MS);
        current.once("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0 || signal === backend.stopSignal) resolve();
          else reject(new Error(`Recorder exited (${code ?? signal})`));
        });
        current.kill(backend.stopSignal);
      });
      return path;
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }

  function cancel(): void {
    const current = child;
    const path = file;
    child = undefined;
    file = undefined;
    current?.removeAllListeners();
    current?.kill("SIGKILL");
    if (path) rmSync(path, { force: true });
  }

  return {
    get isRecording() {
      return child !== undefined;
    },
    start,
    stop,
    cancel,
    discard: removeFile,
  };
}
