import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { inputDeviceSchema } from "./devices";

export const transcriptionProfileSchema = Type.Union([
  Type.Object({
    type: Type.Literal("local"),
    model: Type.Optional(Type.String({ minLength: 1 })),
    binary: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    type: Type.Literal("api"),
    endpoint: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
    format: Type.Optional(Type.Union([Type.Literal("multipart"), Type.Literal("openrouter")])),
  }),
]);

export const voiceSettingsSchema = Type.Object({
  inputDevice: Type.Optional(inputDeviceSchema),
  activeProfile: Type.String({ minLength: 1 }),
  profiles: Type.Record(Type.String(), transcriptionProfileSchema),
});

export type TranscriptionProfile = Type.Static<typeof transcriptionProfileSchema>;
export type VoiceSettings = Type.Static<typeof voiceSettingsSchema>;
export type VoiceSettingsError = { path: string; message: string };
export type VoiceSettingsResult =
  | { settings: VoiceSettings; errors: [] }
  | { settings: undefined; errors: VoiceSettingsError[] };

/** Validate known settings without rejecting or removing extra keys. */
export function validateVoiceSettings(value: unknown): VoiceSettingsResult {
  if (!Value.Check(voiceSettingsSchema, value)) {
    return {
      settings: undefined,
      errors: Value.Errors(voiceSettingsSchema, value).map(({ instancePath, message }) => ({
        path: instancePath || "/",
        message,
      })),
    };
  }
  if (!Object.hasOwn(value.profiles, value.activeProfile)) {
    return {
      settings: undefined,
      errors: [
        { path: "/activeProfile", message: `Profile "${value.activeProfile}" does not exist` },
      ],
    };
  }
  return { settings: value, errors: [] };
}

/** A missing file has no settings and no errors. Read, JSON and validation failures are returned. */
export function loadVoiceSettings(path: string): VoiceSettingsResult {
  if (!existsSync(path)) return { settings: undefined, errors: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateVoiceSettings(parsed);
  } catch (error) {
    return {
      settings: undefined,
      errors: [{ path: "/", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function saveVoiceSettings(path: string, settings: VoiceSettings): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getActiveProfile(settings?: VoiceSettings): {
  name: string;
  transcription: TranscriptionProfile;
} {
  if (!settings) return { name: "local", transcription: { type: "local" } };
  const name = settings.activeProfile;
  const transcription = settings.profiles[name];
  if (!transcription) throw new Error(`Unknown voice profile: ${name}`);
  return { name, transcription };
}
