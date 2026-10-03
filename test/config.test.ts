import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { testdir } from "vitest-testdirs";

import {
  getActiveProfile,
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
} from "../src/config";

const SETTINGS: VoiceSettings = {
  inputDevice: { id: "coreaudio:Mic", name: "Mic", format: "coreaudio", source: "Mic" },
  activeProfile: "remote",
  profiles: {
    local: { type: "local", model: "~/.cache/whisper/ggml-base.bin", binary: "~/bin/whisper-cli" },
    remote: {
      type: "api",
      endpoint: "https://stt.example.com/v1",
      model: "whisper-1",
      apiKeyEnv: "STT_KEY",
    },
  },
};

/** Write `settings` as a settings file and return its path. */
async function settingsFile(settings: unknown): Promise<string> {
  const dir = await testdir({ "voice.json": JSON.stringify(settings) });
  return join(dir, "voice.json");
}

describe("loadVoiceSettings", () => {
  it("treats a missing file as no settings", async () => {
    expect(loadVoiceSettings(join(await testdir({}), "voice.json"))).toEqual({
      settings: undefined,
      errors: [],
    });
  });

  it("returns settings exactly as written, without defaults or path expansion", async () => {
    expect(loadVoiceSettings(await settingsFile(SETTINGS))).toEqual({
      settings: SETTINGS,
      errors: [],
    });
  });

  it.each([
    ["an unknown key", { ...SETTINGS, input: "Mic" }, undefined],
    [
      "an api profile without a model",
      {
        activeProfile: "r",
        profiles: { r: { type: "api", endpoint: "https://x", models: ["a"] } },
      },
      "/profiles/r",
    ],
    [
      "an extra local profile key",
      { activeProfile: "l", profiles: { l: { type: "local", modle: "x" } } },
      undefined,
    ],
    [
      "an unknown profile type",
      { activeProfile: "r", profiles: { r: { type: "remote" } } },
      "/profiles/r",
    ],
    [
      "an empty api endpoint",
      { activeProfile: "r", profiles: { r: { type: "api", endpoint: "", model: "m" } } },
      "/profiles/r",
    ],
    [
      "an unsupported device format",
      { ...SETTINGS, inputDevice: { id: "jack:x", name: "x", format: "jack", source: "x" } },
      "/inputDevice/format",
    ],
  ])("returns validation results for %s", async (_case, settings, errorPath) => {
    const result = loadVoiceSettings(await settingsFile(settings));
    if (errorPath === undefined) {
      expect(result).toEqual({ settings, errors: [] });
    } else {
      expect(result.settings).toBeUndefined();
      expect(result.errors.map(({ path }) => path)).toContain(errorPath);
    }
  });

  it.each([
    ["a missing activeProfile", { profiles: { l: { type: "local" } } }],
    [
      "an activeProfile naming no profile",
      { activeProfile: "x", profiles: { l: { type: "local" } } },
    ],
    [
      "an inherited property name",
      { activeProfile: "constructor", profiles: { l: { type: "local" } } },
    ],
  ])("returns errors for %s", async (_case, settings) => {
    const result = loadVoiceSettings(await settingsFile(settings));
    expect(result.settings).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns a parse error for malformed JSON", async () => {
    const dir = await testdir({ "voice.json": "{ nope" });
    const result = loadVoiceSettings(join(dir, "voice.json"));
    expect(result.settings).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("/");
  });
});

describe("saveVoiceSettings", () => {
  it("writes formatted JSON that loads back unchanged", async () => {
    const path = join(await testdir({}), "voice.json");
    saveVoiceSettings(path, SETTINGS);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(SETTINGS, null, 2)}\n`);
    expect(loadVoiceSettings(path)).toEqual({ settings: SETTINGS, errors: [] });
  });
});

describe("getActiveProfile", () => {
  it("uses local transcription with an auto-detected model without profiles", () => {
    expect(getActiveProfile()).toEqual({ name: "local", transcription: { type: "local" } });
  });

  it("returns the active profile itself, so edits to it are saved", () => {
    const active = getActiveProfile(SETTINGS);
    expect(active.name).toBe("remote");
    expect(active.transcription).toBe(SETTINGS.profiles?.remote);
  });
});
