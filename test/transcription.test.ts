import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { testdir } from "vitest-testdirs";

import { AUDIO_SAMPLE_RATE, type RecordedAudio } from "../src/audio";
import type { TranscriptionProfile } from "../src/config";
import { createTranscriber, transcribe } from "../src/transcription";

const native = vi.hoisted(() => {
  const stream = {
    feed: vi.fn<(pcm: Float32Array) => Promise<void>>(),
    finalize: vi.fn<() => Promise<void>>(),
    reset: vi.fn<() => void>(),
    text: { full: "partial", committed: "part", tentative: "ial" },
    snapshot: { text: "  final words  " },
  };
  const session = {
    stream: vi.fn<(...args: unknown[]) => Promise<typeof stream>>(),
    dispose: vi.fn<() => void>(),
  };
  const model = {
    capabilities: { supportsStreaming: false },
    transcribe: vi.fn<
      (
        pcm: Float32Array,
        options?: {
          timestamps?: string;
          language?: string;
          signal?: AbortSignal;
        },
      ) => Promise<{ text: string }>
    >(),
    createSession: vi.fn<() => typeof session>(),
    dispose: vi.fn<() => void>(),
  };
  const load = vi.fn<(path: string) => Promise<typeof model>>();
  return { stream, session, model, load };
});

vi.mock("transcribe-cpp", () => ({ TranscribeModel: { load: native.load } }));

const AUDIO: RecordedAudio = {
  sampleRate: AUDIO_SAMPLE_RATE,
  pcm: new Float32Array([-0.5, 0, 0.5]),
};
// Independent fixture: mono 16 kHz, 16-bit WAV containing [-16384, 0, 16384].
const WAV = Buffer.from(
  "524946462a00000057415645666d74201000000001000100803e0000007d000002001000646174610600000000c000000040",
  "hex",
);

beforeEach(() => {
  native.load.mockReset().mockResolvedValue(native.model);
  native.model.transcribe.mockReset().mockResolvedValue({ text: "  hello world  " });
  native.model.capabilities.supportsStreaming = false;
  native.model.createSession.mockReset().mockReturnValue(native.session);
  native.model.dispose.mockReset();
  native.session.stream.mockReset().mockResolvedValue(native.stream);
  native.session.dispose.mockReset();
  native.stream.feed.mockReset().mockResolvedValue();
  native.stream.finalize.mockReset().mockResolvedValue();
  native.stream.reset.mockReset();
  native.stream.text = { full: "partial", committed: "part", tentative: "ial" };
  native.stream.snapshot = { text: "  final words  " };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture() {
  const dir = await testdir({ "model.gguf": "fake model", "old.bin": "old model" });
  return { dir, model: join(dir, "model.gguf"), oldModel: join(dir, "old.bin") };
}

const local = (model: string, language?: string): TranscriptionProfile => ({
  type: "local",
  model,
  language,
});

async function reusable(language?: string) {
  const { model } = await fixture();
  const transcriber = await createTranscriber(local(model, language));
  onTestFinished(() => {
    transcriber.dispose();
  });
  return transcriber;
}

describe("local transcription", () => {
  it("returns trimmed text and disposes a one-shot model", async () => {
    const { model } = await fixture();
    await expect(transcribe(AUDIO, local(model))).resolves.toBe("hello world");
    expect(native.load).toHaveBeenCalledWith(model);
    expect(native.model.dispose).toHaveBeenCalledOnce();
  });

  it("passes PCM and the configured language directly to the native model", async () => {
    const { model } = await fixture();
    await transcribe(AUDIO, local(model, "da"));
    expect(native.model.transcribe).toHaveBeenCalledWith(AUDIO.pcm, {
      timestamps: "none",
      language: "da",
      signal: undefined,
    });
  });

  it("expands ~/ when loading a GGUF model", async () => {
    const { dir, model } = await fixture();
    vi.stubEnv("HOME", dir);
    await transcribe(AUDIO, local("~/model.gguf"));
    expect(native.load).toHaveBeenCalledWith(model);
  });

  it("rejects empty PCM before loading a model", async () => {
    const { model } = await fixture();
    await expect(
      transcribe({ sampleRate: AUDIO_SAMPLE_RATE, pcm: new Float32Array() }, local(model)),
    ).rejects.toThrow("Recording is empty");
    expect(native.load).not.toHaveBeenCalled();
  });

  it("rejects a missing model with its configured path", async () => {
    vi.stubEnv("HOME", await testdir({}));
    await expect(transcribe(AUDIO, local("~/nope/model.gguf"))).rejects.toThrow(
      "Transcription model not found at ~/nope/model.gguf",
    );
    expect(native.load).not.toHaveBeenCalled();
  });

  it("rejects without a model when none is installed", async () => {
    vi.stubEnv("HOME", await testdir({}));
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    await expect(transcribe(AUDIO, { type: "local" })).rejects.toThrow(
      "No GGUF model found; download one or configure a local model",
    );
  });

  it("rejects old binary models before native loading", async () => {
    const { oldModel } = await fixture();
    await expect(transcribe(AUDIO, local(oldModel))).rejects.toThrow(
      "Local transcription requires a GGUF model",
    );
    expect(native.load).not.toHaveBeenCalled();
  });

  it("propagates native load failures", async () => {
    const { model } = await fixture();
    native.load.mockRejectedValueOnce(new Error("Invalid GGUF model"));
    await expect(transcribe(AUDIO, local(model))).rejects.toThrow("Invalid GGUF model");
    expect(native.model.transcribe).not.toHaveBeenCalled();
  });

  it("propagates native transcription failures and disposes the one-shot model", async () => {
    const { model } = await fixture();
    native.model.transcribe.mockRejectedValueOnce(new Error("Unsupported language"));
    await expect(transcribe(AUDIO, local(model, "xx"))).rejects.toThrow("Unsupported language");
    expect(native.model.dispose).toHaveBeenCalledOnce();
  });

  it("rejects empty native output as no speech", async () => {
    const { model } = await fixture();
    native.model.transcribe.mockResolvedValueOnce({ text: "   " });
    await expect(transcribe(AUDIO, local(model))).rejects.toThrow("No speech detected");
    expect(native.model.dispose).toHaveBeenCalledOnce();
  });

  it("passes a cancellation signal to native inference", async () => {
    const { model } = await fixture();
    const controller = new AbortController();
    await transcribe(AUDIO, local(model), { signal: controller.signal });
    expect(native.model.transcribe).toHaveBeenCalledWith(
      AUDIO.pcm,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("keeps a reusable model loaded across recordings until disposed", async () => {
    const { model } = await fixture();
    const transcriber = await createTranscriber(local(model));
    await transcriber.transcribe(AUDIO);
    await transcriber.transcribe(AUDIO);
    expect(native.load).toHaveBeenCalledOnce();
    expect(native.model.transcribe).toHaveBeenCalledTimes(2);
    expect(native.model.dispose).not.toHaveBeenCalled();
    transcriber.dispose();
    expect(native.model.dispose).toHaveBeenCalledOnce();
  });

  it("uses native language detection for an auto language profile", async () => {
    const transcriber = await reusable("auto");
    await transcriber.transcribe(AUDIO);
    expect(native.model.transcribe).toHaveBeenCalledWith(
      AUDIO.pcm,
      expect.objectContaining({ language: undefined }),
    );
  });

  it("discovers a GGUF model when the local profile omits its path", async () => {
    const dir = await testdir({
      ".cache": { "agent-voice": { "whisper-small.gguf": "fake model" } },
    });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    await transcribe(AUDIO, { type: "local" });
    expect(native.load).toHaveBeenCalledWith(
      join(dir, ".cache", "agent-voice", "whisper-small.gguf"),
    );
  });

  it("rejects Bun before importing or loading local inference", async () => {
    const { model } = await fixture();
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.2" } });
    await expect(createTranscriber(local(model))).rejects.toThrow(
      "Local transcription with transcribe-cpp 0.2.4 is not supported in Bun",
    );
    expect(native.load).not.toHaveBeenCalled();
  });
});

describe("streaming transcription", () => {
  it("returns undefined for batch-only models without creating a session", async () => {
    const transcriber = await reusable();
    expect(transcriber.supportsStreaming).toBe(false);
    await expect(transcriber.startStream()).resolves.toBeUndefined();
    expect(native.model.createSession).not.toHaveBeenCalled();
  });

  it("queues frames in order and drains them before finalizing", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable("en");
    expect(transcriber.supportsStreaming).toBe(true);
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    const gate = Promise.withResolvers<void>();
    native.stream.feed.mockImplementationOnce(() => gate.promise);
    const firstFrame = new Float32Array([0.1]);
    const secondFrame = new Float32Array([0.2]);
    const first = stream.feed(firstFrame);
    const second = stream.feed(secondFrame);
    const finalized = stream.finalize();
    await vi.waitFor(() => {
      expect(native.stream.feed).toHaveBeenCalledTimes(1);
    });
    expect(native.stream.finalize).not.toHaveBeenCalled();
    gate.resolve();
    await expect(first).resolves.toEqual(native.stream.text);
    await expect(second).resolves.toEqual(native.stream.text);
    await expect(finalized).resolves.toBe("final words");
    expect(native.stream.feed).toHaveBeenNthCalledWith(1, firstFrame);
    expect(native.stream.feed).toHaveBeenNthCalledWith(2, secondFrame);
    expect(native.session.stream).toHaveBeenCalledWith({ timestamps: "none", language: "en" });
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
    expect(native.model.dispose).not.toHaveBeenCalled();
  });

  it("cancel releases the stream session without disposing the reusable model", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    await stream.cancel();
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
    expect(native.model.dispose).not.toHaveBeenCalled();
  });

  it("cancels queued frames before native feeding starts", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    const fed = stream.feed(AUDIO.pcm);
    const rejected = expect(fed).rejects.toThrow("Transcription stream is closed");
    await stream.cancel();
    await rejected;
    await stream.cancel();

    expect(native.stream.feed).not.toHaveBeenCalled();
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
    await expect(stream.feed(AUDIO.pcm)).rejects.toThrow("Transcription stream is closed");
    await expect(stream.finalize()).rejects.toThrow("Transcription stream is closed");
  });

  it("waits for an in-flight feed and cancels queued frames and finalization", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    const gate = Promise.withResolvers<void>();
    native.stream.feed.mockImplementationOnce(() => gate.promise);
    const first = stream.feed(AUDIO.pcm);
    const second = stream.feed(AUDIO.pcm);
    const finalized = stream.finalize();
    const rejected = [
      expect(first).rejects.toThrow("Transcription stream is closed"),
      expect(second).rejects.toThrow("Transcription stream is closed"),
      expect(finalized).rejects.toThrow("Transcription stream is closed"),
    ];
    await vi.waitFor(() => {
      expect(native.stream.feed).toHaveBeenCalledOnce();
    });
    const cancelled = stream.cancel();
    expect(native.stream.reset).not.toHaveBeenCalled();
    expect(native.session.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([...rejected, cancelled]);

    expect(native.stream.feed).toHaveBeenCalledOnce();
    expect(native.stream.finalize).not.toHaveBeenCalled();
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
    expect(native.model.dispose).not.toHaveBeenCalled();
  });

  it("waits for native finalization when cancellation races with it", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    const gate = Promise.withResolvers<void>();
    native.stream.finalize.mockImplementationOnce(() => gate.promise);
    const finalized = stream.finalize();
    const rejected = expect(finalized).rejects.toThrow("Transcription stream is closed");
    await vi.waitFor(() => {
      expect(native.stream.finalize).toHaveBeenCalledOnce();
    });
    const cancelled = stream.cancel();
    expect(native.session.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([rejected, cancelled]);
    await stream.cancel();

    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
  });

  it("rejects new work once finalization begins", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    const finalized = stream.finalize();
    await expect(stream.feed(AUDIO.pcm)).rejects.toThrow("Transcription stream is finishing");
    await expect(finalized).resolves.toBe("final words");
    await expect(stream.finalize()).rejects.toThrow("Transcription stream is closed");

    expect(native.stream.feed).not.toHaveBeenCalled();
    expect(native.stream.finalize).toHaveBeenCalledOnce();
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
  });

  it("releases the session if starting a native stream fails", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    native.session.stream.mockRejectedValueOnce(new Error("Stream startup failed"));
    await expect(transcriber.startStream()).rejects.toThrow("Stream startup failed");
    expect(native.session.dispose).toHaveBeenCalledOnce();
    expect(native.model.dispose).not.toHaveBeenCalled();
  });

  it("propagates feed failure and releases the session when finalized", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    native.stream.feed.mockRejectedValueOnce(new Error("Feed failed"));
    await expect(stream.feed(AUDIO.pcm)).rejects.toThrow("Feed failed");
    await expect(stream.finalize()).rejects.toThrow("Feed failed");
    expect(native.stream.finalize).not.toHaveBeenCalled();
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
  });

  it("releases the session when native finalization fails", async () => {
    native.model.capabilities.supportsStreaming = true;
    const transcriber = await reusable();
    const stream = await transcriber.startStream();
    if (!stream) throw new Error("The streaming fixture did not create a stream");
    native.stream.finalize.mockRejectedValueOnce(new Error("Finalize failed"));
    await expect(stream.finalize()).rejects.toThrow("Finalize failed");
    expect(native.stream.reset).toHaveBeenCalledOnce();
    expect(native.session.dispose).toHaveBeenCalledOnce();
  });
});

async function apiServer(payload: unknown, status = 200) {
  const requests: { url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("API fixture has no TCP port");
  return { url: `http://127.0.0.1:${address.port}/v1/`, requests };
}

describe("api transcription", () => {
  it("posts multipart with a PCM-encoded WAV and returns trimmed text", async () => {
    const server = await apiServer({ text: "  hello  " });
    await expect(
      transcribe(AUDIO, { type: "api", endpoint: server.url, model: "whisper-1" }),
    ).resolves.toBe("hello");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/v1/audio/transcriptions");
    expect(server.requests[0]?.headers["content-type"]).toContain("multipart/form-data");
    expect(server.requests[0]?.body.toString()).toContain("whisper-1");
    expect(server.requests[0]?.body.includes(WAV)).toBe(true);
    expect(native.load).not.toHaveBeenCalled();
  });

  it("posts OpenRouter JSON with a base64-encoded WAV", async () => {
    const server = await apiServer({ text: "hi" });
    await expect(
      transcribe(AUDIO, { type: "api", endpoint: server.url, model: "m", format: "openrouter" }),
    ).resolves.toBe("hi");
    expect(JSON.parse(server.requests[0]?.body.toString() ?? "")).toEqual({
      model: "m",
      input_audio: { data: WAV.toString("base64"), format: "wav" },
    });
  });

  it("sends the bearer token when configured", async () => {
    vi.stubEnv("VOICE_STT_API_KEY", "secret");
    const server = await apiServer({ text: "hi" });
    await transcribe(AUDIO, {
      type: "api",
      endpoint: server.url,
      model: "m",
      apiKeyEnv: "VOICE_STT_API_KEY",
    });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("throws before sending when the API key variable is missing", async () => {
    vi.stubEnv("UNSET_KEY", "");
    const server = await apiServer({ text: "hi" });
    await expect(
      transcribe(AUDIO, {
        type: "api",
        endpoint: server.url,
        model: "m",
        apiKeyEnv: "UNSET_KEY",
      }),
    ).rejects.toThrow("Set UNSET_KEY to use the transcription API");
    expect(server.requests).toHaveLength(0);
  });

  it("throws on HTTP errors", async () => {
    const server = await apiServer({}, 500);
    await expect(
      transcribe(AUDIO, { type: "api", endpoint: server.url, model: "m" }),
    ).rejects.toThrow("Transcription API returned HTTP 500");
  });

  it("throws on empty text", async () => {
    const server = await apiServer({ text: "  " });
    await expect(
      transcribe(AUDIO, { type: "api", endpoint: server.url, model: "m" }),
    ).rejects.toThrow("No speech detected");
  });

  it("reports an invalid API response instead of treating it as silence", async () => {
    const server = await apiServer({ unexpected: "value" });
    await expect(
      transcribe(AUDIO, { type: "api", endpoint: server.url, model: "m" }),
    ).rejects.toThrow("Transcription API response is missing text");
  });

  it("keeps API profiles available under Bun without native inference", async () => {
    const server = await apiServer({ text: "hello" });
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.2" } });
    const transcriber = await createTranscriber({ type: "api", endpoint: server.url, model: "m" });
    expect(transcriber.supportsStreaming).toBe(false);
    await expect(transcriber.startStream()).resolves.toBeUndefined();
    await expect(transcriber.transcribe(AUDIO)).resolves.toBe("hello");
    transcriber.dispose();
    expect(native.load).not.toHaveBeenCalled();
  });

  it("honors an aborted API request signal", async () => {
    const server = await apiServer({ text: "hello" });
    const controller = new AbortController();
    controller.abort(new Error("Request cancelled"));
    await expect(
      transcribe(
        AUDIO,
        {
          type: "api",
          endpoint: server.url,
          model: "m",
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Request cancelled");
    expect(server.requests).toHaveLength(0);
  });
});
