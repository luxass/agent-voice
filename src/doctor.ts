import { existsSync } from "node:fs";

import { getActiveProfile, type TranscriptionProfile, type VoiceSettings } from "./config";
import { listInputDevices, type InputDevice } from "./devices";
import { discoverLocalModels } from "./models";
import { expandHome, findExecutable } from "./paths";

export type DoctorCheckId = "sox" | "device" | "whisper-cli" | "model" | "api-key";

/** One setup check. Failed checks carry a `fix`; hosts can swap in their own command by `id`. */
export type DoctorCheck = { id: DoctorCheckId; ok: boolean; detail: string; fix?: string };

export type DoctorOptions = {
  /** Lists inputs to verify a saved device. Defaults to `listInputDevices`. */
  listDevices?: () => Promise<InputDevice[]>;
};

const INSTALL: Record<"sox" | "whisper-cli", Record<string, string>> = {
  sox: {
    darwin: "brew install sox",
    linux: "install the sox package, e.g. `sudo apt install sox`",
    other: "install SoX: https://sourceforge.net/projects/sox/",
  },
  "whisper-cli": {
    darwin: "brew install whisper-cpp",
    other: "build whisper.cpp: https://github.com/ggml-org/whisper.cpp",
  },
};

function checkExecutable(id: "sox" | "whisper-cli", command: string): DoctorCheck {
  const path = findExecutable(command);
  return {
    id,
    ok: path != null,
    detail: path ?? `${command} not found`,
    fix: path == null ? (INSTALL[id][process.platform] ?? INSTALL[id].other) : undefined,
  };
}

async function checkDevice(
  device: InputDevice,
  listDevices: () => Promise<InputDevice[]>,
): Promise<DoctorCheck> {
  const ok = (await listDevices()).some((candidate) => candidate.id === device.id);
  return {
    id: "device",
    ok,
    detail: ok ? device.name : `${device.name} is not connected`,
    fix: ok ? undefined : "choose another input device",
  };
}

function checkModel(name: string, model = discoverLocalModels()[0]): DoctorCheck {
  const ok = model != null && existsSync(expandHome(model));
  return {
    id: "model",
    ok,
    detail: model == null ? "No Whisper model found" : ok ? model : `${model} does not exist`,
    fix: ok ? undefined : `choose or download a model for profile ${name}`,
  };
}

function checkApiKey(env: string): DoctorCheck {
  const key = process.env[env];
  const ok = key != null && key !== "";
  return {
    id: "api-key",
    ok,
    detail: `${env} is ${ok ? "set" : "not set"}`,
    fix: ok ? undefined : `set ${env} in your environment`,
  };
}

function checkProfile(name: string, profile: TranscriptionProfile): DoctorCheck[] {
  if (profile.type === "local")
    return [
      checkExecutable("whisper-cli", profile.binary ?? "whisper-cli"),
      checkModel(name, profile.model),
    ];
  return profile.apiKeyEnv == null ? [] : [checkApiKey(profile.apiKeyEnv)];
}

/**
 * Check what the active profile needs to record and transcribe, without recording or
 * calling any API. Only checks that apply to the settings are returned.
 */
export async function runDoctor(
  settings?: VoiceSettings,
  { listDevices = listInputDevices }: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const { name, transcription } = getActiveProfile(settings);
  return [
    checkExecutable("sox", "sox"),
    ...(settings?.inputDevice ? [await checkDevice(settings.inputDevice, listDevices)] : []),
    ...checkProfile(name, transcription),
  ];
}
