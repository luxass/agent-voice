import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { inputDeviceSchema } from "./devices";

const strict = { additionalProperties: false } as const;

const apiProfileSchema = Type.Object(
  {
    type: Type.Literal("api"),
    endpoint: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
    format: Type.Optional(Type.Union([Type.Literal("multipart"), Type.Literal("openrouter")])),
  },
  strict,
);

const localProfileSchema = Type.Object(
  {
    type: Type.Literal("local"),
    model: Type.Optional(Type.String({ minLength: 1 })),
    binary: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.String({ minLength: 1 })),
  },
  strict,
);

// Validate a profile only against the variant its `type` selects, so errors name that variant's fields.
const transcriptionProfileSchema = Type.Unsafe<
  Type.Static<typeof apiProfileSchema> | Type.Static<typeof localProfileSchema>
>({
  if: Type.Object({ type: Type.Literal("api") }),
  // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise
  then: apiProfileSchema,
  else: localProfileSchema,
});

const voiceSettingsSchema = Type.Object(
  {
    inputDevice: Type.Optional(inputDeviceSchema),
    activeProfile: Type.Optional(Type.String()),
    profiles: Type.Optional(Type.Record(Type.String(), transcriptionProfileSchema)),
  },
  strict,
);

export type TranscriptionProfile = Type.Static<typeof transcriptionProfileSchema>;
export type VoiceSettings = Type.Static<typeof voiceSettingsSchema>;

function parseVoiceSettings(value: unknown): VoiceSettings {
  if (!Value.Check(voiceSettingsSchema, value)) {
    const [error] = Value.Errors(voiceSettingsSchema, value);
    // A failed api profile only reports `must match "then" schema`; re-check it for the detail.
    const [detail] =
      error?.keyword === "if"
        ? Value.Errors(apiProfileSchema, Value.Pointer.Get(value, error.instancePath))
        : [];
    const reported = detail ?? error;
    // `additionalProperties: false` reports unknown keys as "schema is false".
    const message = reported?.keyword === "boolean" ? "unknown setting" : reported?.message;
    const path = `${error?.instancePath ?? ""}${detail?.instancePath ?? ""}`;
    throw new Error(`Invalid voice settings at ${path || "/"}: ${message}`);
  }
  if (value.profiles && !Object.hasOwn(value.profiles, value.activeProfile ?? ""))
    throw new Error("activeProfile must name a profile");
  return value;
}

/**
 * Read and validate the settings file at a host-chosen path. A missing file means no settings.
 * Values are returned as written: no defaults are added and `~/` paths are kept.
 */
export function loadVoiceSettings(path: string): VoiceSettings {
  return existsSync(path) ? parseVoiceSettings(JSON.parse(readFileSync(path, "utf8"))) : {};
}

export function saveVoiceSettings(path: string, settings: VoiceSettings): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getActiveProfile(settings: VoiceSettings): {
  name: string;
  transcription: TranscriptionProfile;
} {
  if (!settings.profiles) return { name: "local", transcription: { type: "local" } };
  const name = settings.activeProfile ?? "";
  const transcription = settings.profiles[name];
  if (!transcription) throw new Error(`Unknown voice profile: ${name}`);
  return { name, transcription };
}
