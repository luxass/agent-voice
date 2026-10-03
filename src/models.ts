import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/**
 * A curated GGUF download compatible with transcribe.cpp.
 */
export type DownloadableModel = {
  name: string;
  approxMB: number;
  repository: string;
  revision: string;
  filename: string;
};

/**
 * GGUF models, including a streaming model. Arbitrary compatible GGUF paths also work.
 */
export const MODEL_CATALOG: readonly DownloadableModel[] = [
  {
    name: "parakeet-tdt_ctc-110m",
    approxMB: 135,
    repository: "handy-computer/parakeet-tdt_ctc-110m-gguf",
    revision: "9d66d34f9e1594075c5dd72c90c0f4c321b29f21",
    filename: "parakeet-tdt_ctc-110m-Q8_0.gguf",
  },
  {
    name: "whisper-small",
    approxMB: 270,
    repository: "handy-computer/whisper-small-gguf",
    revision: "c0214bd34be9296695486f838e0142f900803159",
    filename: "whisper-small-Q8_0.gguf",
  },
  {
    name: "parakeet-unified-en-0.6b",
    approxMB: 732,
    repository: "handy-computer/parakeet-unified-en-0.6b-gguf",
    revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
    filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
  },
  {
    name: "whisper-medium",
    approxMB: 832,
    repository: "handy-computer/whisper-medium-gguf",
    revision: "ec78f06fded51aa82cde751678b78f76f78c8b7f",
    filename: "whisper-medium-Q8_0.gguf",
  },
  {
    name: "whisper-large-v3-turbo",
    approxMB: 887,
    repository: "handy-computer/whisper-large-v3-turbo-gguf",
    revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
    filename: "whisper-large-v3-turbo-Q8_0.gguf",
  },
];

/**
 * Get the directory used for model downloads and discovery.
 *
 * @returns `$AGENT_VOICE_MODEL_DIR` when set, otherwise `~/.cache/agent-voice`.
 */
export function modelDir(): string {
  const dir = process.env.AGENT_VOICE_MODEL_DIR;
  return dir == null || dir === "" ? join(homedir(), ".cache", "agent-voice") : dir;
}

/**
 * Build a model's GGUF path.
 *
 * @param {string} name - Model name without the file extension.
 * @param {string} [dir] - Destination directory, defaulting to `modelDir()`.
 * @returns The path to `<name>.gguf`.
 */
export function modelPath(name: string, dir = modelDir()): string {
  return join(dir, `${name}.gguf`);
}

/**
 * Find installed GGUF models. The first result is the default for local profiles.
 *
 * @param {string} [dir] - Directory to search, defaulting to `modelDir()`.
 * @returns Paths sorted by name, or an empty list if the directory cannot be read.
 */
export function discoverLocalModels(dir = modelDir()): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".gguf"))
    .map((entry) => join(dir, entry.name))
    .filter((path) => existsSync(path))
    .toSorted();
}

/**
 * A model for a picker: installed in the model directory, or a curated download.
 */
export type LocalModel = { name: string; path: string; installed: boolean; approxMB?: number };

/**
 * List models for a picker.
 *
 * @param {string} [dir] - Model directory, defaulting to `modelDir()`.
 * @returns Installed models followed by catalog entries available to download.
 */
export function listLocalModels(dir = modelDir()): LocalModel[] {
  const installed = discoverLocalModels(dir);
  return [
    ...installed.map((path) => ({
      name: basename(path, ".gguf"),
      path,
      installed: true,
    })),
    ...MODEL_CATALOG.map(({ name, approxMB }) => ({
      name,
      path: modelPath(name, dir),
      installed: false,
      approxMB,
    })).filter(({ path }) => !installed.includes(path)),
  ];
}

export type DownloadModelOptions = {
  /**
   * Directory to save into. Defaults to `modelDir()`.
   */
  dir?: string;
  signal?: AbortSignal;
  /**
   * Called per received chunk. `total` is undefined when the server sends no length.
   */
  onProgress?: (received: number, total: number | undefined) => void;
};

/**
 * Download a catalog model from its pinned Hugging Face revision.
 * Overwrite an existing model only after the download completes.
 *
 * @param {string} name - A name from `MODEL_CATALOG`.
 * @param {DownloadModelOptions} [options] - Destination directory, abort signal, and progress callback.
 * @returns The saved GGUF path.
 * @throws If the name is unknown, the download is aborted, or fetching or saving fails.
 */
export async function downloadModel(
  name: string,
  { dir = modelDir(), signal, onProgress }: DownloadModelOptions = {},
): Promise<string> {
  const model = MODEL_CATALOG.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`Unknown downloadable model: ${name}`);
  const target = modelPath(name, dir);
  // Unique per call, so concurrent downloads of one model never share a partial file.
  const partial = `${target}.${randomUUID()}.part`;

  await mkdir(dir, { recursive: true });
  const response = await fetch(
    `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`,
    { signal },
  );
  if (!response.ok || !response.body) {
    // Release the connection instead of leaving the error body unread.
    await response.body?.cancel();
    throw new Error(`Downloading ${name} failed: HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length"));
  const total = length > 0 ? length : undefined;

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
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}
