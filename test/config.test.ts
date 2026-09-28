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
    expect(loadVoiceSettings(join(await testdir({}), "voice.json"))).toEqual({});
  });

  it("returns settings exactly as written, without defaults or path expansion", async () => {
    expect(loadVoiceSettings(await settingsFile(SETTINGS))).toEqual(SETTINGS);
  });

  it.each([
    ["an unknown key", { input: "Mic" }, "at /input: unknown setting"],
    [
      "an old-style api profile",
      {
        activeProfile: "r",
        profiles: { r: { type: "api", endpoint: "https://x", models: ["a"] } },
      },
      "at /profiles/r: must have required properties model",
    ],
    [
      "a misspelled local profile key",
      { activeProfile: "l", profiles: { l: { type: "local", modle: "x" } } },
      "at /profiles/l/modle: unknown setting",
    ],
    [
      "an unknown profile type",
      { activeProfile: "r", profiles: { r: { type: "remote" } } },
      "at /profiles/r/type: must be equal to constant",
    ],
    [
      "an empty api endpoint",
      { activeProfile: "r", profiles: { r: { type: "api", endpoint: "", model: "m" } } },
      "at /profiles/r/endpoint: must not have fewer than 1 characters",
    ],
    [
      "an unsupported device format",
      { inputDevice: { id: "jack:x", name: "x", format: "jack", source: "x" } },
      "at /inputDevice/format: must be equal to constant",
    ],
  ])("rejects %s and names the field", async (_case, settings, message) => {
    const path = await settingsFile(settings);
    expect(() => loadVoiceSettings(path)).toThrow(`Invalid voice settings ${message}`);
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
  ])("rejects %s when profiles exist", async (_case, settings) => {
    const path = await settingsFile(settings);
    expect(() => loadVoiceSettings(path)).toThrow("activeProfile must name a profile");
  });

  it("rejects malformed JSON", async () => {
    const dir = await testdir({ "voice.json": "{ nope" });
    expect(() => loadVoiceSettings(join(dir, "voice.json"))).toThrow(SyntaxError);
  });
});

describe("saveVoiceSettings", () => {
  it("writes formatted JSON that loads back unchanged", async () => {
    const path = join(await testdir({}), "voice.json");
    saveVoiceSettings(path, SETTINGS);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(SETTINGS, null, 2)}\n`);
    expect(loadVoiceSettings(path)).toEqual(SETTINGS);
  });
});

describe("getActiveProfile", () => {
  it("uses local transcription with an auto-detected model without profiles", () => {
    expect(getActiveProfile({})).toEqual({ name: "local", transcription: { type: "local" } });
  });

  it("returns the active profile itself, so edits to it are saved", () => {
    const active = getActiveProfile(SETTINGS);
    expect(active.name).toBe("remote");
    expect(active.transcription).toBe(SETTINGS.profiles?.remote);
  });
});
