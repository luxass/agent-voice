import { existsSync } from "node:fs";

import { getActiveProfile, type TranscriptionProfile, type VoiceSettings } from "./config";
import { listInputDevices, type InputDevice } from "./devices";
import { discoverLocalModels } from "./models";
import { expandHome, findExecutable } from "./paths";

export type DoctorCheckId = "sox" | "device" | "whisper-cli" | "model" | "api-key";

/** One setup check. Hosts key their own wording or fix hints off `id`. */
export type DoctorCheck = { id: DoctorCheckId; ok: boolean; detail: string };

export type DoctorOptions = {
  /** Lists inputs to verify a saved device. Defaults to `listInputDevices`. */
  listDevices?: () => Promise<InputDevice[]>;
};

async function checkDevice(
  device: InputDevice,
  listDevices: () => Promise<InputDevice[]>,
): Promise<DoctorCheck> {
  try {
    const ok = (await listDevices()).some((candidate) => candidate.id === device.id);
    return { id: "device", ok, detail: ok ? device.name : `${device.name} is not connected` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: "device", ok: false, detail: `Cannot list inputs: ${message}` };
  }
}

function checkModel(model: string | undefined): DoctorCheck {
  if (model !== undefined) {
    const ok = existsSync(expandHome(model));
    return { id: "model", ok, detail: ok ? model : `${model} does not exist` };
  }
  const [discovered] = discoverLocalModels();
  return discovered === undefined
    ? { id: "model", ok: false, detail: "No Whisper model found" }
    : { id: "model", ok: true, detail: `${discovered} (auto-detected)` };
}

function checkExecutable(id: "sox" | "whisper-cli", command: string): DoctorCheck {
  const path = findExecutable(command);
  return { id, ok: path !== undefined, detail: path ?? `${command} not found` };
}

function checkProfile(profile: TranscriptionProfile): DoctorCheck[] {
  if (profile.type === "local")
    return [
      checkExecutable("whisper-cli", profile.binary ?? "whisper-cli"),
      checkModel(profile.model),
    ];
  if (profile.apiKeyEnv === undefined) return [];
  const key = process.env[profile.apiKeyEnv];
  const ok = key !== undefined && key !== "";
  return [{ id: "api-key", ok, detail: `${profile.apiKeyEnv} is ${ok ? "set" : "not set"}` }];
}

/**
 * Check what the active profile needs to record and transcribe, without recording or
 * calling any API. Only checks that apply to the settings are returned.
 */
export async function runDoctor(
  settings: VoiceSettings,
  { listDevices = listInputDevices }: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  return [
    checkExecutable("sox", "sox"),
    ...(settings.inputDevice ? [await checkDevice(settings.inputDevice, listDevices)] : []),
    ...checkProfile(getActiveProfile(settings).transcription),
  ];
}
