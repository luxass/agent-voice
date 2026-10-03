import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecorder, type Recorder } from "../../src";

describe.runIf(process.platform === "linux")("Linux Recording", () => {
  let recorder: Recorder;

  beforeEach(async () => {
    recorder = await createRecorder();
  });

  afterEach(async () => {
    await recorder?.cancel();
  });

  it("records audio from the default microphone", async () => {
    const captured = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) captured.resolve();
      },
      onError: captured.reject,
    });

    expect(recorder.isRecording).toBe(true);
    await captured.promise;
    const audio = await recorder.stop();

    expect(audio.sampleRate).toBe(16_000);
    expect(audio.pcm).toBeInstanceOf(Float32Array);
    expect(audio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);
  });

  it("delivers 480-sample Float32 chunks", async () => {
    const captured = Promise.withResolvers<Float32Array>();
    await recorder.start({
      onFrame: captured.resolve,
      onError: captured.reject,
    });

    const frame = await captured.promise;
    await recorder.stop();

    expect(frame).toBeInstanceOf(Float32Array);
    expect(frame.length).toBe(480);
    expect(recorder.isRecording).toBe(false);
  });

  it("records twice with the same recorder", async () => {
    const firstCapture = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) firstCapture.resolve();
      },
      onError: firstCapture.reject,
    });
    await firstCapture.promise;
    const firstAudio = await recorder.stop();

    expect(firstAudio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);

    const secondCapture = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) secondCapture.resolve();
      },
      onError: secondCapture.reject,
    });
    await secondCapture.promise;
    const secondAudio = await recorder.stop();

    expect(secondAudio.sampleRate).toBe(16_000);
    expect(secondAudio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);
  });

  it("records again after cancellation", async () => {
    const discardedCapture = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) discardedCapture.resolve();
      },
      onError: discardedCapture.reject,
    });
    await discardedCapture.promise;
    await recorder.cancel();

    expect(recorder.isRecording).toBe(false);

    const captured = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) captured.resolve();
      },
      onError: captured.reject,
    });
    await captured.promise;
    const audio = await recorder.stop();

    expect(audio.sampleRate).toBe(16_000);
    expect(audio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);
  });

  it("rejects a second start without interrupting capture", async () => {
    const captured = Promise.withResolvers<void>();
    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) captured.resolve();
      },
      onError: captured.reject,
    });
    await captured.promise;

    await expect(recorder.start({ onError: captured.reject })).rejects.toThrow("Already recording");
    expect(recorder.isRecording).toBe(true);

    const audio = await recorder.stop();

    expect(audio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);
  });

  it("rejects an unavailable input and can still record afterward", async () => {
    const captured = Promise.withResolvers<void>();
    await expect(
      recorder.start({
        input: { id: "agent-voice-unavailable-input", name: "Unavailable microphone" },
        onError: captured.reject,
      }),
    ).rejects.toMatchObject({ name: "RecorderError", code: "DeviceUnavailable" });

    expect(recorder.isRecording).toBe(false);

    await recorder.start({
      onFrame(frame) {
        if (frame.some((sample) => sample !== 0)) captured.resolve();
      },
      onError: captured.reject,
    });
    await captured.promise;
    const audio = await recorder.stop();

    expect(audio.pcm.some((sample) => sample !== 0)).toBe(true);
    expect(recorder.isRecording).toBe(false);
  });
});
