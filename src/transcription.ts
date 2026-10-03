import { existsSync } from "node:fs";

import type { StreamText } from "transcribe-cpp";

import { encodeWav, type RecordedAudio } from "./audio";
import type { TranscriptionProfile } from "./config";
import { discoverLocalModels } from "./models";
import { expandHome } from "./paths";

type ApiProfile = Extract<TranscriptionProfile, { type: "api" }>;

export type TranscriptionOptions = { signal?: AbortSignal };
export type TranscriptText = Pick<StreamText, "full" | "committed" | "tentative">;

export type TranscriptionStream = {
  /**
   * Queue a frame for streaming transcription.
   *
   * @param {Float32Array} frame - PCM to feed. Keep it read-only until the promise resolves.
   * @returns Full, committed, and tentative text after processing the frame.
   */
  feed: (frame: Float32Array) => Promise<TranscriptText>;
  /**
   * Stop capture first, then drain queued frames and release the session.
   *
   * @returns The final transcript.
   * @throws If feeding or finalization fails, or no speech is detected.
   */
  finalize: () => Promise<string>;
  /**
   * Discard the stream and release its session. Safe during an in-flight feed.
   */
  cancel: () => void;
};

export type Transcriber = {
  readonly supportsStreaming: boolean;
  /**
   * Transcribe PCM locally or upload a WAV to the API. API requests time out after 60 seconds.
   *
   * @param {RecordedAudio} audio - The completed recording.
   * @param {TranscriptionOptions} [options] - Optional abort signal for inference or the API request.
   * @returns The trimmed transcript.
   * @throws If audio is empty, no speech is detected, or transcription fails.
   */
  transcribe: (audio: RecordedAudio, options?: TranscriptionOptions) => Promise<string>;
  /**
   * Start a local streaming session.
   *
   * @returns A stream, or `undefined` for API profiles and batch-only models.
   * @throws If a supported model cannot create a streaming session.
   */
  startStream: () => Promise<TranscriptionStream | undefined>;
  /**
   * Dispose on profile changes or host shutdown. Releases local models and their sessions.
   */
  dispose: () => void;
};

const TIMEOUT_MS = 60_000;

function finishTranscript(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("No speech detected");
  return trimmed;
}

async function postAudio(
  audio: RecordedAudio,
  profile: ApiProfile,
  { signal }: TranscriptionOptions,
): Promise<string> {
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  if (profile.apiKeyEnv != null) {
    const key = process.env[profile.apiKeyEnv];
    if (key == null || key === "")
      throw new Error(`Set ${profile.apiKeyEnv} to use the transcription API`);
    headers.Authorization = `Bearer ${key}`;
  }
  const wav = encodeWav(audio);
  let body: BodyInit;
  if (profile.format === "openrouter") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: profile.model,
      input_audio: { data: wav.toString("base64"), format: "wav" },
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", profile.model);
    form.append("response_format", "json");
    body = form;
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${profile.endpoint.replace(/\/+$/u, "")}/audio/transcriptions`, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Transcription API returned HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("text" in result) ||
    typeof result.text !== "string"
  )
    throw new Error("Transcription API response is missing text");
  return finishTranscript(result.text);
}

/**
 * Create a reusable transcriber. Local GGUF models stay loaded until `dispose()`.
 * Local paths support `~/`; omitting a path uses the first discovered model.
 *
 * API profiles default to multipart WAV. Use `format: "openrouter"` for JSON audio;
 * `apiKeyEnv` names the environment variable supplying the bearer token.
 *
 * @param {TranscriptionProfile} profile - Local model or API configuration.
 * @returns A transcriber bound to the profile.
 * @throws If local transcription is requested under Bun or the GGUF model cannot load.
 */
export async function createTranscriber(profile: TranscriptionProfile): Promise<Transcriber> {
  if (profile.type === "api") {
    const selected = { ...profile };
    return {
      supportsStreaming: false,
      async transcribe(audio: RecordedAudio, options: TranscriptionOptions = {}) {
        if (audio.pcm.length === 0) throw new Error("Recording is empty");
        return postAudio(audio, selected, options);
      },
      startStream: () => Promise.resolve(undefined),
      dispose() {
        // API profiles have no persistent native resources.
      },
    };
  }

  // transcribe-cpp 0.2.4 documents a Bun N-API finalizer crash. Do not load it there.
  if (process.versions.bun)
    throw new Error(
      "Local transcription with transcribe-cpp 0.2.4 is not supported in Bun; use an API profile",
    );
  const path = profile.model ?? discoverLocalModels()[0];
  if (path == null) throw new Error("No GGUF model found; download one or configure a local model");
  const modelPath = expandHome(path);
  if (!existsSync(modelPath)) throw new Error(`Transcription model not found at ${path}`);
  if (!modelPath.endsWith(".gguf")) throw new Error("Local transcription requires a GGUF model");
  const language = profile.language === "auto" ? undefined : profile.language;
  const { TranscribeModel } = await import("transcribe-cpp");
  const model = await TranscribeModel.load(modelPath);
  const options = { timestamps: "none", language } satisfies Parameters<typeof model.transcribe>[1];

  return {
    supportsStreaming: model.capabilities.supportsStreaming,
    async transcribe(audio: RecordedAudio, { signal }: TranscriptionOptions = {}) {
      if (audio.pcm.length === 0) throw new Error("Recording is empty");
      const result = await model.transcribe(audio.pcm, { ...options, signal });
      return finishTranscript(result.text);
    },
    async startStream(): Promise<TranscriptionStream | undefined> {
      if (!model.capabilities.supportsStreaming) return undefined;
      const session = model.createSession();
      try {
        const stream = await session.stream(options);
        let pending = Promise.resolve<TranscriptText>(stream.text);
        return {
          feed(frame: Float32Array) {
            pending = pending.then(async () => {
              await stream.feed(frame);
              return stream.text;
            });
            return pending;
          },
          async finalize() {
            try {
              await pending;
              await stream.finalize();
              return finishTranscript(stream.snapshot.text);
            } finally {
              stream.reset();
              session.dispose();
            }
          },
          cancel() {
            stream.reset();
            session.dispose();
          },
        };
      } catch (error) {
        session.dispose();
        throw error;
      }
    },
    dispose() {
      model.dispose();
    },
  };
}

/**
 * Transcribe once and dispose the transcriber. Use `createTranscriber()` to reuse a model.
 *
 * @param {RecordedAudio} audio - The completed recording.
 * @param {TranscriptionProfile} profile - Local model or API configuration.
 * @param {TranscriptionOptions} [options] - Optional abort signal.
 * @returns The trimmed transcript.
 * @throws If transcriber creation fails, audio is empty, or transcription fails.
 */
export async function transcribe(
  audio: RecordedAudio,
  profile: TranscriptionProfile,
  options: TranscriptionOptions = {},
): Promise<string> {
  if (audio.pcm.length === 0) throw new Error("Recording is empty");
  const transcriber = await createTranscriber(profile);
  try {
    return await transcriber.transcribe(audio, options);
  } finally {
    transcriber.dispose();
  }
}
