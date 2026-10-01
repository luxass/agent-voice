import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { TranscriptionProfile } from "./config";
import { discoverLocalModels } from "./models";
import { expandHome } from "./paths";

type LocalProfile = Extract<TranscriptionProfile, { type: "local" }>;
type ApiProfile = Extract<TranscriptionProfile, { type: "api" }>;

const TIMEOUT_MS = 60_000;

/** Run `command` to completion, killing it after `TIMEOUT_MS`. */
function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Transcription timed out (${TIMEOUT_MS / 1000}s)`));
    }, TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runWhisperCli(file: string, profile: LocalProfile): Promise<string> {
  const model = profile.model ?? discoverLocalModels()[0];
  if (model == null)
    throw new Error("No Whisper model found; download one or configure a local model");
  const modelPath = expandHome(model);
  if (!existsSync(modelPath)) throw new Error(`Whisper model not found at ${model}`);
  const args = ["-m", modelPath, "-f", file, "-l", profile.language ?? "auto", "-np", "-nt"];
  const { code, stdout, stderr } = await run(expandHome(profile.binary ?? "whisper-cli"), args);
  const [, language] = /error: unknown language '([^']+)'/u.exec(stderr) ?? [];
  if (language != null) throw new Error(`Unknown whisper language: ${language}`);
  if (code !== 0) {
    const line = stderr.trim().split("\n").pop();
    throw new Error(line == null || line === "" ? `Whisper exited (${code})` : line);
  }
  return stdout.replaceAll(/\s+/gu, " ").trim();
}

async function postAudio(file: string, profile: ApiProfile): Promise<string> {
  const headers: Record<string, string> = {};
  if (profile.apiKeyEnv != null) {
    const key = process.env[profile.apiKeyEnv];
    if (key == null || key === "")
      throw new Error(`Set ${profile.apiKeyEnv} to use the transcription API`);
    headers.Authorization = `Bearer ${key}`;
  }
  const audio = await readFile(file);

  let body: BodyInit;
  if (profile.format === "openrouter") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: profile.model,
      input_audio: { data: audio.toString("base64"), format: "wav" },
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
    form.append("model", profile.model);
    // Ask for the JSON envelope explicitly instead of relying on the server default.
    form.append("response_format", "json");
    body = form;
  }

  const endpoint = profile.endpoint.replace(/\/+$/u, "");
  const response = await fetch(`${endpoint}/audio/transcriptions`, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Transcription API returned HTTP ${response.status}`);
  const result: unknown = await response.json();
  return typeof result === "object" &&
    result !== null &&
    "text" in result &&
    typeof result.text === "string"
    ? result.text.trim()
    : "";
}

/** Transcribe a WAV file with the selected profile. Local model discovery happens only when needed. */
export async function transcribe(file: string, profile: TranscriptionProfile): Promise<string> {
  // 44 bytes is a bare WAV header.
  if (!existsSync(file) || statSync(file).size <= 44) throw new Error("Recording is empty");
  const text =
    profile.type === "api" ? await postAudio(file, profile) : await runWhisperCli(file, profile);
  if (text === "") throw new Error("No speech detected");
  return text;
}
