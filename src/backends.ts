import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { Transcription } from "./config";
import { listInputDevices, type InputDevice } from "./devices";

/**
 * Capture backend: everything tool-specific about getting microphone audio
 * into a file. The recorder core owns the tmp file lifecycle, spawning,
 * failure reporting, and stop/cancel semantics; the backend only describes
 * _how_ to record.
 */
export type CaptureBackend = {
  readonly name: string;
  /** Binary to spawn, resolved via `PATH` (or an absolute path, handy for tests). */
  readonly command: string;
  /** Signal that finalizes the recording (SoX finalizes its WAV on `SIGINT`). */
  readonly stopSignal: NodeJS.Signals;
  listDevices: () => Promise<InputDevice[]>;
  /** CLI args that record from `input` (system default when `undefined`) into `file`. */
  args: (input: InputDevice | undefined, file: string) => string[];
};

export function soxBackend(command = "sox"): CaptureBackend {
  return {
    name: "sox",
    command,
    stopSignal: "SIGINT",
    listDevices: () => listInputDevices(),
    args: (input, file) => [
      ...(input ? ["-t", input.format, input.source] : ["-d"]),
      // Whisper expects 16kHz mono 16-bit audio.
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      file,
    ],
  };
}

/**
 * Transcription backend: audio file + model in, text out.
 */
export type TranscribeBackend = {
  readonly name: string;
  transcribe: (file: string, model: string) => Promise<string>;
};

function assertAudioFile(file: string): void {
  if (!existsSync(file) || statSync(file).size <= 44) {
    throw new Error("Recording is empty");
  }
}

const TRANSCRIBE_TIMEOUT_MS = 60_000;

export function whisperCliBackend(
  options: {
    binary?: string;
    language?: string;
    timeoutMs?: number;
  } = {},
): TranscribeBackend {
  const binary = options.binary ?? "whisper-cli";
  const language = options.language ?? "auto";
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  return {
    name: "whisper-cli",
    transcribe: async (file, model) => {
      assertAudioFile(file);
      if (!existsSync(model)) throw new Error(`Whisper model not found at ${model}`);
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, ["-m", model, "-f", file, "-l", language, "-np", "-nt"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let errors = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Transcription timed out (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const languageError = errors.match(/error: unknown language '([^']+)'/);
          if (languageError)
            return reject(new Error(`Unknown whisper language: ${languageError[1]}`));
          if (code !== 0)
            return reject(new Error(errors.trim().split("\n").pop() || `Whisper exited (${code})`));
          const text = output.replace(/\s+/g, " ").trim();
          if (!text) return reject(new Error("No speech detected"));
          resolve(text);
        });
      });
    },
  };
}

export function apiBackend(options: {
  endpoint: string;
  apiKeyEnv?: string;
  format?: "multipart" | "openrouter";
  timeoutMs?: number;
}): TranscribeBackend {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const format = options.format ?? "multipart";
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  return {
    name: "api",
    transcribe: async (file, model) => {
      assertAudioFile(file);
      const key = options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined;
      if (options.apiKeyEnv && !key)
        throw new Error(`Set ${options.apiKeyEnv} to use the transcription API`);
      const audio = await readFile(file);
      const headers: Record<string, string> = {};
      if (key) headers.Authorization = `Bearer ${key}`;

      let body: BodyInit;
      if (format === "openrouter") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({
          model,
          input_audio: { data: audio.toString("base64"), format: "wav" },
        });
      } else {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
        form.append("model", model);
        // Ask for the JSON envelope explicitly instead of relying on the server default.
        form.append("response_format", "json");
        body = form;
      }

      const response = await fetch(`${endpoint}/audio/transcriptions`, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Transcription API returned HTTP ${response.status}`);
      const result = (await response.json()) as { text?: string };
      const text = result.text?.trim();
      if (!text) throw new Error("No speech detected");
      return text;
    },
  };
}

export function createTranscribeBackend(
  config: Transcription,
  options: { timeoutMs?: number } = {},
): TranscribeBackend {
  if (config.type === "api") {
    return apiBackend({
      endpoint: config.endpoint,
      apiKeyEnv: config.apiKeyEnv,
      format: config.format,
      timeoutMs: options.timeoutMs,
    });
  }
  return whisperCliBackend({
    binary: config.binary,
    language: config.language,
    timeoutMs: options.timeoutMs,
  });
}
