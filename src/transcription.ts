import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { createTranscribeBackend } from "./backends";
import { defaultModel, type Transcription } from "./config";

export function modelChoices(config: Transcription): { title: string; value: string }[] {
  if (config.type === "api") {
    return config.models.map((model) => ({ title: model, value: model }));
  }
  let models: string[] = [];
  try {
    models = readdirSync(config.modelsDirectory, { withFileTypes: true })
      .filter(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && /^ggml-.*\.bin$/.test(entry.name),
      )
      .map((entry) => join(config.modelsDirectory, entry.name))
      .filter(existsSync);
  } catch {
    // A configured model outside the directory is still available below.
  }
  if (existsSync(config.model) && !models.includes(config.model)) models.push(config.model);
  return models.toSorted().map((model) => ({ title: basename(model), value: model }));
}

/**
 * Transcribe `file` with the backend described by `config`, overriding the
 * configured default model when `model` is given (e.g. a picker selection).
 */
export function transcribe(
  file: string,
  config: Transcription,
  model: string | undefined = defaultModel(config),
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return createTranscribeBackend(config, options).transcribe(file, model);
}
