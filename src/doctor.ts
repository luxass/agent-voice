import { existsSync } from "node:fs";

import { getActiveProfile, type TranscriptionProfile, type VoiceSettings } from "./config";
import { listInputDevices, type InputDevice } from "./devices";
import { discoverLocalModels } from "./models";
import { expandHome } from "./paths";

export type DoctorCheckId = "device" | "inference" | "model" | "api-key";

/**
 * One setup check. Failed checks carry a `fix`; hosts can swap in their own command by `id`.
 */
export type DoctorCheck = { id: DoctorCheckId; ok: boolean; detail: string; fix?: string };

export type DoctorOptions = {
  /**
   * Lists inputs to verify a saved device. Defaults to `listInputDevices`.
   */
  listDevices?: () => Promise<InputDevice[]>;
};

async function checkInference(): Promise<DoctorCheck> {
  // oxlint-disable-next-line typescript/strict-boolean-expressions
  if (process.versions.bun)
    return {
      id: "inference",
      ok: false,
      detail: "transcribe-cpp 0.2.4 is not supported in Bun",
      fix: "use an API profile",
    };
  try {
    const { getAvailableBackends } = await import("transcribe-cpp");
    const backends = getAvailableBackends();
    return {
      id: "inference",
      ok: backends.length > 0,
      detail:
        backends.length > 0
          ? backends.map(({ name }) => name).join(", ")
          : "No native inference backends found",
      fix: backends.length > 0 ? undefined : "check native inference support for this platform",
    };
  } catch (error) {
    return {
      id: "inference",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: `check native inference support for ${process.platform}/${process.arch}`,
    };
  }
}

async function checkDevice(
  device: InputDevice | undefined,
  listDevices: () => Promise<InputDevice[]>,
): Promise<DoctorCheck> {
  try {
    const devices = await listDevices();
    const ok = device
      ? devices.some((candidate) => candidate.id === device.id)
      : devices.length > 0;
    return {
      id: "device",
      ok,
      detail: device
        ? ok
          ? device.name
          : `${device.name} is not connected`
        : ok
          ? "System default input"
          : "No input devices found",
      fix: ok ? undefined : device ? "choose another input device" : "connect a microphone",
    };
  } catch (error) {
    return {
      id: "device",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: `check native recorder support for ${process.platform}/${process.arch}`,
    };
  }
}

function checkModel(name: string, model = discoverLocalModels()[0]): DoctorCheck {
  const ok = model != null && model.endsWith(".gguf") && existsSync(expandHome(model));
  return {
    id: "model",
    ok,
    detail:
      model == null
        ? "No GGUF model found"
        : model.endsWith(".gguf")
          ? ok
            ? model
            : `${model} does not exist`
          : `${model} is not a GGUF model`,
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

async function checkProfile(name: string, profile: TranscriptionProfile): Promise<DoctorCheck[]> {
  if (profile.type === "local") return [await checkInference(), checkModel(name, profile.model)];
  return profile.apiKeyEnv == null ? [] : [checkApiKey(profile.apiKeyEnv)];
}

/**
 * Check readiness without recording or calling a transcription API.
 *
 * @param {VoiceSettings} [settings] - Omit to check the default local profile.
 * @param {DoctorOptions} [options] - Optional device enumeration override.
 * @returns Checks applicable to the active profile, with a suggested fix for failures.
 * @throws If the active profile is absent from `profiles`.
 */
export async function runDoctor(
  settings?: VoiceSettings,
  { listDevices = listInputDevices }: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const { name, transcription } = getActiveProfile(settings);
  return [
    await checkDevice(settings?.inputDevice, listDevices),
    ...(await checkProfile(name, transcription)),
  ];
}
