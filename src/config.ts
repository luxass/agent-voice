import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultLocalModel } from "./models";

export type LocalTranscription = {
  type: "local";
  model: string;
  modelsDirectory: string;
  binary: string;
  language: string;
};

export type ApiTranscription = {
  type: "api";
  endpoint: string;
  /** Model choices; the first entry is the default. */
  models: string[];
  apiKeyEnv?: string;
  format: "multipart" | "openrouter";
};

export type Transcription = LocalTranscription | ApiTranscription;

export type VoiceConfig = {
  input: string;
  /** Active profile name. Exactly one profile transcribes at a time. */
  activeTranscription: string;
  transcriptions: Record<string, Transcription>;
};

function pathFromHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? join(homedir(), value.slice(2))
      : value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function parseTranscription(
  raw: Record<string, unknown> | undefined,
  label: string,
): Transcription {
  if (raw?.type === "api") {
    const endpoint = text(raw.endpoint, `${label}.endpoint`);
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`${label}.endpoint must use HTTP or HTTPS`);
    }
    if (!Array.isArray(raw.models) || raw.models.length === 0) {
      throw new Error(`${label}.models must be a non-empty list of model IDs`);
    }
    const models = [...new Set(raw.models.map((item) => text(item, `${label}.models entry`)))];
    const format = raw.format ?? "multipart";
    if (format !== "multipart" && format !== "openrouter") {
      throw new Error(`${label}.format must be multipart or openrouter`);
    }
    return {
      type: "api",
      endpoint: endpoint.replace(/\/+$/, ""),
      models,
      apiKeyEnv:
        raw.apiKeyEnv === undefined ? undefined : text(raw.apiKeyEnv, `${label}.apiKeyEnv`),
      format,
    };
  }

  if (raw !== undefined && raw.type !== "local") {
    throw new Error(`${label}.type must be local or api`);
  }
  // Zero-config default: first installed model from the well-known directories.
  // Falls back to the historical path so the error names a concrete file.
  const model = pathFromHome(
    raw?.model === undefined
      ? (defaultLocalModel() ??
          join(homedir(), ".local", "share", "whisper-cpp", "ggml-large-v3-turbo-q5_0.bin"))
      : text(raw.model, `${label}.model`),
  );
  return {
    type: "local",
    model,
    modelsDirectory:
      raw?.modelsDirectory === undefined
        ? dirname(model)
        : pathFromHome(text(raw.modelsDirectory, `${label}.modelsDirectory`)),
    binary:
      raw?.binary === undefined ? "whisper-cli" : pathFromHome(text(raw.binary, `${label}.binary`)),
    language: raw?.language === undefined ? "auto" : text(raw.language, `${label}.language`),
  };
}

/** Default model for a transcription config: the configured local path, or the first API model. */
export function defaultModel(config: Transcription): string {
  if (config.type === "api") {
    const first = config.models[0];
    if (!first) throw new Error("API transcription needs at least one model");
    return first;
  }
  return config.model;
}

/** Look up a named transcription profile. Throws on unknown names. */
export function transcriptionProfile(config: VoiceConfig, name: string): Transcription {
  const profile = config.transcriptions[name];
  if (!profile) throw new Error(`Unknown transcription profile: ${name}`);
  return profile;
}

export function resolveOptions(options: Record<string, unknown>): VoiceConfig {
  // An explicit empty string means "system default", same as omitting the key.
  const input =
    options.input === undefined || (typeof options.input === "string" && !options.input.trim())
      ? ""
      : text(options.input, "input");
  // A missing map means zero-config: one `default` profile with local defaults.
  // `undefined` is a valid profile value and also resolves to local defaults.
  const profiles = (options.transcriptions ?? { default: undefined }) as Record<string, unknown>;
  if (typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("transcriptions must be an object of named transcription configs");
  }
  const names = Object.keys(profiles);
  if (names.length === 0)
    throw new Error("transcriptions must name at least one transcription config");
  const transcriptions: Record<string, Transcription> = {};
  for (const name of names) {
    const raw = profiles[name] as Record<string, unknown> | undefined;
    if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
      throw new Error(`transcriptions.${name} must be an object`);
    }
    transcriptions[name] = parseTranscription(raw, `transcriptions.${name}`);
  }
  const first = names[0] as string;
  const active =
    options.activeTranscription === undefined
      ? first
      : text(options.activeTranscription, "activeTranscription");
  if (!transcriptions[active]) throw new Error(`Unknown transcription profile: ${active}`);
  return { input, activeTranscription: active, transcriptions };
}
