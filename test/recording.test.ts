import type { RecorderOptions, Recording } from "@handy-computer/recorder";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { AUDIO_SAMPLE_RATE } from "../src/audio";
import { createRecorder } from "../src/recording";

const native = vi.hoisted(() => {
  const startup = vi.fn<() => void>();
  const instances: FakeRecorder[] = [];

  class FakeRecorderError extends Error {
    override readonly name = "RecorderError";
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  class FakeRecorder {
    isRecording = false;
    isClosed = false;
    samples = new Float32Array();

    constructor(readonly options: RecorderOptions) {
      instances.push(this);
    }

    start = vi.fn(() => {
      startup();
      this.isRecording = true;
    });

    stop = vi.fn<() => Promise<Recording>>(async () => {
      this.isRecording = false;
      return this.recording();
    });

    close = vi.fn(async () => {
      this.isRecording = false;
      this.isClosed = true;
    });

    recording(): Recording {
      return {
        samples: this.samples,
        sampleRate: 16000,
        channels: 1,
        complete: true,
        droppedFrames: 0,
        endReason: { kind: "stopCalled" },
      };
    }

    emit(samples: Float32Array): void {
      this.samples = Float32Array.of(...this.samples, ...samples);
      this.options.onChunk?.({ samples, sampleRate: 16000, channels: 1 });
    }

    fail(error: FakeRecorderError): void {
      this.options.onFailure?.(error);
    }
  }

  const open = vi.fn<(options: RecorderOptions) => Promise<FakeRecorder>>();
  return { open, startup, instances, FakeRecorder, RecorderError: FakeRecorderError };
});

vi.mock("@handy-computer/recorder", () => ({
  Recorder: { open: native.open },
  SPEECH: { sampleRate: 16000, channels: "mono", framesPerChunk: 480 },
}));

beforeEach(() => {
  native.open
    .mockReset()
    .mockImplementation((options) => Promise.resolve(new native.FakeRecorder(options)));
  native.startup.mockReset();
  native.instances.length = 0;
});

async function fixture() {
  const recorder = await createRecorder();
  onTestFinished(() => recorder.cancel());
  return recorder;
}

function capturedDevice() {
  const device = native.instances.at(-1);
  if (!device) throw new Error("The test did not open a native recorder");
  return device;
}

const MIC = { id: "mic-id", name: "Mic" };

describe("createRecorder", () => {
  it("does not open the microphone until start is called", async () => {
    const recorder = await fixture();
    expect(native.open).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
  });

  it("returns native Float32 PCM without conversion and closes capture", async () => {
    const recorder = await fixture();
    const onError = vi.fn<(error: Error) => void>();
    const onFrame = vi.fn<(frame: Float32Array) => void>();
    await recorder.start({ onError, onFrame });
    const device = capturedDevice();
    const frame = new Float32Array([-1, 0, 0.5, 1]);
    device.emit(frame);
    expect(recorder.isRecording).toBe(true);
    expect(onFrame).toHaveBeenCalledWith(frame);

    const audio = await recorder.stop();
    expect(audio.sampleRate).toBe(AUDIO_SAMPLE_RATE);
    expect(audio.pcm).toBe(device.samples);
    expect(audio.pcm).toEqual(frame);
    expect(onError).not.toHaveBeenCalled();
    expect(device.stop).toHaveBeenCalledOnce();
    expect(device.close).toHaveBeenCalledOnce();
    expect(recorder.isRecording).toBe(false);
  });

  it("passes the saved native device ID and speech preset to open", async () => {
    const recorder = await fixture();
    await recorder.start({ input: MIC, onError: vi.fn() });
    expect(native.open).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "mic-id",
        sampleRate: 16000,
        channels: "mono",
        framesPerChunk: 480,
      }),
    );
    await recorder.cancel();
    await recorder.start({ input: MIC, onError: vi.fn() });
    expect(native.open).toHaveBeenLastCalledWith(expect.objectContaining({ device: "mic-id" }));
  });

  it("uses the system default input when no device is selected", async () => {
    const recorder = await fixture();
    await recorder.start({ onError: vi.fn() });
    expect(native.open).toHaveBeenCalledWith(expect.objectContaining({ device: undefined }));
  });

  it("rejects a second start while the microphone is still opening", async () => {
    const recorder = await fixture();
    const opening = Promise.withResolvers<InstanceType<typeof native.FakeRecorder>>();
    native.open.mockImplementationOnce(() => opening.promise);
    const started = recorder.start({ onError: vi.fn() });
    await expect(recorder.start({ onError: vi.fn() })).rejects.toThrow("Already recording");
    const device = new native.FakeRecorder({});
    opening.resolve(device);
    await started;
    expect(device.start).toHaveBeenCalledOnce();
  });

  it("rejects stopping without a recording", async () => {
    const recorder = await fixture();
    await expect(recorder.stop()).rejects.toThrow("No recording in progress");
  });

  it("closes capture before reporting a native failure", async () => {
    const recorder = await fixture();
    const onError = vi.fn<(error: Error) => void>();
    await recorder.start({ onError });
    const device = capturedDevice();
    const closed = Promise.withResolvers<void>();
    device.close.mockImplementationOnce(() => closed.promise);
    const error = new native.RecorderError("DeviceLost", "Microphone disconnected");
    device.fail(error);
    await vi.waitFor(() => expect(device.close).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
    closed.resolve();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
    expect(recorder.isRecording).toBe(false);
  });

  it("closes the native handle and rejects when start fails", async () => {
    const recorder = await fixture();
    native.startup.mockImplementationOnce(() => {
      throw new native.RecorderError("PermissionDenied", "Microphone access denied");
    });
    const onError = vi.fn<(error: Error) => void>();
    await expect(recorder.start({ onError })).rejects.toThrow("Microphone access denied");
    expect(capturedDevice().close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
  });

  it("delivers the final chunk before resolving stop and closing the device", async () => {
    const recorder = await fixture();
    const onFrame = vi.fn<(frame: Float32Array) => void>();
    await recorder.start({ onError: vi.fn(), onFrame });
    const device = capturedDevice();
    const stopping = Promise.withResolvers<Recording>();
    device.stop.mockImplementationOnce(() => stopping.promise);
    const stopped = recorder.stop();
    await vi.waitFor(() => expect(device.stop).toHaveBeenCalledOnce());
    expect(device.close).not.toHaveBeenCalled();
    const tail = new Float32Array([0.25]);
    device.emit(tail);
    stopping.resolve(device.recording());
    await expect(stopped).resolves.toEqual({ sampleRate: AUDIO_SAMPLE_RATE, pcm: tail });
    expect(onFrame).toHaveBeenCalledWith(tail);
    expect(device.close).toHaveBeenCalledOnce();
  });

  it("cancel closes and discards audio without calling stop, and is safe when idle", async () => {
    const recorder = await fixture();
    await recorder.cancel();
    await recorder.start({ onError: vi.fn() });
    const device = capturedDevice();
    device.emit(new Float32Array([0.5]));
    await recorder.cancel();
    expect(device.close).toHaveBeenCalledOnce();
    expect(device.stop).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
    await recorder.cancel();

    await recorder.start({ onError: vi.fn() });
    await expect(recorder.stop()).resolves.toEqual({
      sampleRate: AUDIO_SAMPLE_RATE,
      pcm: new Float32Array(),
    });
  });

  it("cancel waits for a pending open and closes the resulting device", async () => {
    const recorder = await fixture();
    const opening = Promise.withResolvers<InstanceType<typeof native.FakeRecorder>>();
    native.open.mockImplementationOnce(() => opening.promise);
    const started = recorder.start({ onError: vi.fn() });
    const cancelled = recorder.cancel();
    const device = new native.FakeRecorder({});
    opening.resolve(device);
    await Promise.all([started, cancelled]);
    expect(device.close).toHaveBeenCalledOnce();
    expect(recorder.isRecording).toBe(false);
  });

  it("propagates a disconnected saved device error without falling back to another input", async () => {
    const recorder = await fixture();
    const error = new native.RecorderError(
      "DeviceUnavailable",
      "Selected microphone is unavailable",
    );
    native.open.mockRejectedValueOnce(error);
    await expect(recorder.start({ input: MIC, onError: vi.fn() })).rejects.toBe(error);
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.open).toHaveBeenCalledWith(expect.objectContaining({ device: "mic-id" }));
    expect(recorder.isRecording).toBe(false);
  });

  it("reports frame callback failures and closes capture once", async () => {
    const recorder = await fixture();
    const onError = vi.fn<(error: Error) => void>();
    await recorder.start({
      onError,
      onFrame() {
        throw new Error("Frame consumer failed");
      },
    });
    const device = capturedDevice();
    device.emit(new Float32Array([0.1]));
    device.emit(new Float32Array([0.2]));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0].message).toBe("Frame consumer failed");
    expect(device.close).toHaveBeenCalledOnce();
    expect(recorder.isRecording).toBe(false);
  });

  it("rejects incomplete audio when frames were dropped", async () => {
    const recorder = await fixture();
    await recorder.start({ onError: vi.fn() });
    const device = capturedDevice();
    device.stop.mockResolvedValueOnce({
      ...device.recording(),
      complete: false,
      droppedFrames: 20,
    });
    await expect(recorder.stop()).rejects.toThrow("Recording dropped 20 audio frames");
    expect(device.close).toHaveBeenCalledOnce();
  });

  it("preserves the native failure when stop returns incomplete capture", async () => {
    const recorder = await fixture();
    await recorder.start({ onError: vi.fn() });
    const device = capturedDevice();
    const error = new native.RecorderError("Stalled", "Microphone stalled");
    device.stop.mockResolvedValueOnce({
      ...device.recording(),
      complete: false,
      endReason: { kind: "recorderFailed", error },
    });
    await expect(recorder.stop()).rejects.toBe(error);
    expect(device.close).toHaveBeenCalledOnce();
  });
});
