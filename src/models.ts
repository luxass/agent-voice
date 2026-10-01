import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** A downloadable whisper.cpp model. `.en` models are English-only; the rest are multilingual. */
export type WhisperModel = { name: string; approxMB: number };

/** A curated set of whisper.cpp models, smallest first within each group. */
export const WHISPER_MODELS: readonly WhisperModel[] = [
  { name: "tiny.en", approxMB: 75 },
  { name: "base.en", approxMB: 142 },
  { name: "small.en", approxMB: 466 },
  { name: "large-v3-turbo-q5_0", approxMB: 547 },
  { name: "base", approxMB: 142 },
  { name: "small", approxMB: 466 },
  { name: "large-v3-turbo", approxMB: 1549 },
];

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** The one model directory, for downloads and discovery: `$AGENT_VOICE_MODEL_DIR`, else `~/.cache/whisper`. */
export function modelDir(): string {
  const dir = process.env.AGENT_VOICE_MODEL_DIR;
  return dir === undefined || dir === "" ? join(homedir(), ".cache", "whisper") : dir;
}

/** The file a model named `name` (e.g. `base.en`) is stored as in `dir`. */
export function modelPath(name: string, dir = modelDir()): string {
  return join(dir, `ggml-${name}.bin`);
}

/**
 * Installed whisper.cpp models in `dir` (default `modelDir()`), sorted by name.
 * The first result is the zero-config default model.
 */
export function discoverLocalModels(dir = modelDir()): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && /^ggml-.*\.bin$/u.test(entry.name),
    )
    .map((entry) => join(dir, entry.name))
    .filter((path) => existsSync(path))
    .toSorted();
}

export type DownloadModelOptions = {
  /** Directory to save into. Defaults to `modelDir()`. */
  dir?: string;
  signal?: AbortSignal;
  /** Called per received chunk. `total` is undefined when the server sends no length. */
  onProgress?: (received: number, total: number | undefined) => void;
};

/**
 * Download a whisper.cpp model from Hugging Face and return its path. The file is written
 * as `<path>.part` and renamed when complete; a failed or aborted download removes it, so a
 * partial file is never discovered as a model. An existing model is overwritten.
 */
export async function downloadModel(
  name: string,
  { dir = modelDir(), signal, onProgress }: DownloadModelOptions = {},
): Promise<string> {
  if (!/^[\w.-]+$/u.test(name)) throw new Error(`Invalid Whisper model name: ${name}`);
  const target = modelPath(name, dir);
  const partial = `${target}.part`;

  const response = await fetch(`${MODEL_BASE_URL}/ggml-${name}.bin`, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
  // A compressed response's length is not the length of the bytes fetch hands us.
  const length = response.headers.has("content-encoding")
    ? Number.NaN
    : Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;

  mkdirSync(dir, { recursive: true });
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          received += chunk.byteLength;
          onProgress?.(received, total);
          yield chunk;
        }
      },
      createWriteStream(partial),
      { signal },
    );
    if (total !== undefined && received !== total)
      throw new Error(`Downloading ${name} ended early (${received} of ${total} bytes)`);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}
