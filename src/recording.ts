import type { Recorder as HandyRecorder, Recording } from "@handy-computer/recorder";

import { AUDIO_SAMPLE_RATE, type RecordedAudio } from "./audio";
import type { InputDevice } from "./devices";

export type RecordingOptions = {
  /**
   * A device from `listInputDevices()`. Omit for the system default; unavailable IDs reject.
   */
  input?: InputDevice;
  /**
   * Read-only mono PCM at 16 kHz in 480-sample chunks; the last chunk can be shorter.
   * Throwing aborts capture and reports the error through `onError`.
   */
  onFrame?: (frame: Float32Array) => void;
  /**
   * Reports a native failure or frame callback failure after closing the device.
   */
  onError: (error: Error) => void;
};

export type Recorder = {
  /**
   * Whether a capture session is active, including startup and shutdown.
   */
  readonly isRecording: boolean;
  /**
   * Open the microphone and start capture.
   *
   * @param {RecordingOptions} options - Input device and frame/error callbacks.
   * @throws If capture is already active or device startup fails.
   */
  start: (options: RecordingOptions) => Promise<void>;
  /**
   * Finish frame callbacks and close the microphone.
   *
   * @returns The complete captured PCM.
   * @throws If capture is incomplete, the device fails to close, or the recorder is idle.
   */
  stop: () => Promise<RecordedAudio>;
  /**
   * Close and discard capture. Safe when idle; waits for an opening device.
   *
   * @throws If opening or closing the device fails.
   */
  cancel: () => Promise<void>;
};

function recordedAudio(recording: Recording): RecordedAudio {
  if (!recording.complete) {
    const reason = recording.endReason;
    switch (reason.kind) {
      case "recorderFailed":
        throw reason.error;
      case "sinkPanicked":
        throw new Error(`Audio capture failed: ${reason.message}`);
      case "stopCalled":
        throw new Error(`Recording dropped ${recording.droppedFrames} audio frames`);
    }
  }
  return { sampleRate: AUDIO_SAMPLE_RATE, pcm: recording.samples };
}

/**
 * Load the native recording binding.
 *
 * @returns A recorder whose microphone opens when `start()` is called.
 * @throws If the native binding cannot be loaded.
 */
export async function createRecorder(): Promise<Recorder> {
  const { Recorder: NativeRecorder, SPEECH } = await import("@handy-computer/recorder");
  let active: Promise<HandyRecorder> | undefined;

  async function start(options: RecordingOptions): Promise<void> {
    if (active) throw new Error("Already recording");

    function fail(error: unknown): void {
      if (active !== session) return;
      active = undefined;
      void session
        .then((device) => device.close())
        .then(
          () => {
            options.onError(error instanceof Error ? error : new Error(String(error)));
          },
          (closeError: unknown) => {
            options.onError(
              closeError instanceof Error ? closeError : new Error(String(closeError)),
            );
          },
        );
    }

    const session = NativeRecorder.open({
      ...SPEECH,
      device: options.input?.id,
      onChunk({ samples }) {
        if (active !== session) return;
        try {
          options.onFrame?.(samples);
        } catch (error) {
          fail(error);
        }
      },
      onFailure: fail,
    }).then(async (device) => {
      try {
        device.start();
        return device;
      } catch (error) {
        await device.close();
        throw error;
      }
    });

    active = session;
    try {
      await session;
    } catch (error) {
      if (active === session) active = undefined;
      throw error;
    }
  }

  async function stop(): Promise<RecordedAudio> {
    const session = active;
    if (!session) throw new Error("No recording in progress");
    const device = await session;
    try {
      return recordedAudio(await device.stop());
    } finally {
      if (active === session) active = undefined;
      await device.close();
    }
  }

  async function cancel(): Promise<void> {
    const session = active;
    if (!session) return;
    active = undefined;
    const device = await session;
    await device.close();
  }

  return {
    get isRecording() {
      return active != null;
    },
    start,
    stop,
    cancel,
  };
}
