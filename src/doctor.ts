import { existsSync, readdirSync } from "node:fs";

import { getActiveProfile, type TranscriptionProfile, type VoiceSettings } from "./config";
import { listInputDevices, type InputDevice } from "./devices";
import { discoverLocalModels, modelDir } from "./models";
import { expandHome, findExecutable } from "./paths";

export type DoctorCheckId =
  | "sox"
  | "device"
  | "whisper-cli"
  | "model"
  | "partial-download"
  | "api-key";

/** One setup check. Hosts can key their own wording or commands off `id`. */
export type DoctorCheck = { id: DoctorCheckId; ok: boolean; detail: string; fix?: string };

export type DoctorOptions = {
  /** Lists inputs to verify a saved device. Defaults to `listInputDevices`. */
  listDevices?: () => Promise<InputDevice[]>;
};

async function checkDevice(
  device: InputDevice,
  listDevices: () => Promise<InputDevice[]>,
): Promise<DoctorCheck> {
  try {
    const found = (await listDevices()).some((candidate) => candidate.id === device.id);
    return found
      ? { id: "device", ok: true, detail: device.name }
      : {
          id: "device",
          ok: false,
          detail: `${device.name} is not connected`,
          fix: "Choose another input device",
        };
  } catch (error) {
    return {
      id: "device",
      ok: false,
      detail: `Cannot list inputs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function checkModel(model: string | undefined): DoctorCheck {
  if (model !== undefined) {
    return existsSync(expandHome(model))
      ? { id: "model", ok: true, detail: model }
      : {
          id: "model",
          ok: false,
          detail: `${model} does not exist`,
          fix: "Download a Whisper model",
        };
  }
  const [discovered] = discoverLocalModels();
  return discovered === undefined
    ? { id: "model", ok: false, detail: "No Whisper model found", fix: "Download a Whisper model" }
    : { id: "model", ok: true, detail: `${discovered} (auto-detected)` };
}

function partialDownloads(): string[] {
  try {
    return readdirSync(modelDir()).filter((name) => /^ggml-.*\.bin\.part$/u.test(name));
  } catch {
    return [];
  }
}

type LocalProfile = Extract<TranscriptionProfile, { type: "local" }>;

function checkLocal(profile: LocalProfile): DoctorCheck[] {
  const command = profile.binary ?? "whisper-cli";
  const binary = findExecutable(command);
  const checks: DoctorCheck[] = [
    binary === undefined
      ? { id: "whisper-cli", ok: false, detail: `${command} not found`, fix: "Install whisper.cpp" }
      : { id: "whisper-cli", ok: true, detail: binary },
    checkModel(profile.model),
  ];
  const partial = partialDownloads();
  if (partial.length > 0) {
    checks.push({
      id: "partial-download",
      ok: false,
      detail: `Unfinished download in ${modelDir()}: ${partial.join(", ")}`,
      fix: "Download the model again or delete the .part file",
    });
  }
  return checks;
}

function checkApiKey(name: string): DoctorCheck {
  const key = process.env[name];
  return key === undefined || key === ""
    ? {
        id: "api-key",
        ok: false,
        detail: `${name} is not set`,
        fix: `Set ${name} in your environment`,
      }
    : { id: "api-key", ok: true, detail: `${name} is set` };
}

/**
 * Check what the active profile needs to record and transcribe, without recording or
 * calling any API. Only checks that apply to the settings are returned.
 */
export async function runDoctor(
  settings: VoiceSettings,
  { listDevices = listInputDevices }: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const sox = findExecutable("sox");
  const checks: DoctorCheck[] = [
    sox === undefined
      ? { id: "sox", ok: false, detail: "sox not found on PATH", fix: "Install SoX" }
      : { id: "sox", ok: true, detail: sox },
  ];
  if (settings.inputDevice) checks.push(await checkDevice(settings.inputDevice, listDevices));

  const { transcription } = getActiveProfile(settings);
  if (transcription.type === "local") checks.push(...checkLocal(transcription));
  else if (transcription.apiKeyEnv !== undefined) checks.push(checkApiKey(transcription.apiKeyEnv));
  return checks;
}
