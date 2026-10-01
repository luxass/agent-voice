import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { metadata } from "vitest-testdirs/helpers";

import type { InputDevice } from "../src/devices";
import { runDoctor } from "../src/doctor";

const executable = metadata("#!/bin/sh\n", { mode: 0o755 });
const mic: InputDevice = { id: "coreaudio:Mic", name: "Mic", format: "coreaudio", source: "Mic" };

/** HOME and PATH pointed at a test directory with the given executables in `bin/`. */
async function environment(bin: string[], files: Record<string, unknown> = {}) {
  const dir = await testdir({
    bin: Object.fromEntries(bin.map((name) => [name, executable])),
    ...files,
  });
  vi.stubEnv("HOME", dir);
  vi.stubEnv("PATH", join(dir, "bin"));
  vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
  return dir;
}

const platform = process.platform;

function onPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value });
}

describe("runDoctor", () => {
  afterEach(() => {
    onPlatform(platform);
  });

  it("passes a local setup with sox, whisper-cli and a discovered model", async () => {
    const dir = await environment(["sox", "whisper-cli"], {
      ".cache": { whisper: { "ggml-base.en.bin": "" } },
    });
    expect(await runDoctor({})).toEqual([
      { id: "sox", ok: true, detail: join(dir, "bin", "sox") },
      { id: "whisper-cli", ok: true, detail: join(dir, "bin", "whisper-cli") },
      {
        id: "model",
        ok: true,
        detail: join(dir, ".cache", "whisper", "ggml-base.en.bin"),
      },
    ]);
  });

  it("reports missing tools and models with fixes for the platform", async () => {
    await environment([]);
    onPlatform("darwin");
    expect(await runDoctor({})).toEqual([
      { id: "sox", ok: false, detail: "sox not found", fix: "brew install sox" },
      {
        id: "whisper-cli",
        ok: false,
        detail: "whisper-cli not found",
        fix: "brew install whisper-cpp",
      },
      {
        id: "model",
        ok: false,
        detail: "No Whisper model found",
        fix: "choose or download a model for profile local",
      },
    ]);
  });

  it("falls back to generic install fixes on other platforms", async () => {
    await environment([]);
    onPlatform("linux");
    const [sox, whisper] = await runDoctor({});
    expect(sox?.fix).toBe("install the sox package, e.g. `sudo apt install sox`");
    expect(whisper?.fix).toBe("build whisper.cpp: https://github.com/ggml-org/whisper.cpp");
  });

  it("skips directories with an executable's name on PATH", async () => {
    const dir = await testdir({
      shadow: { "whisper-cli": {} },
      bin: { "whisper-cli": executable },
    });
    vi.stubEnv("PATH", `${join(dir, "shadow")}:${join(dir, "bin")}`);
    expect(await runDoctor({})).toContainEqual({
      id: "whisper-cli",
      ok: true,
      detail: join(dir, "bin", "whisper-cli"),
    });
  });

  it("checks a configured binary and model path, expanding ~/", async () => {
    const dir = await environment(["sox"], { tools: { whisper: executable } });
    const checks = await runDoctor({
      activeProfile: "local",
      profiles: { local: { type: "local", binary: "~/tools/whisper", model: "~/gone.bin" } },
    });
    expect(checks.slice(1)).toEqual([
      { id: "whisper-cli", ok: true, detail: join(dir, "tools", "whisper") },
      {
        id: "model",
        ok: false,
        detail: "~/gone.bin does not exist",
        fix: "choose or download a model for profile local",
      },
    ]);
  });

  it("checks the API key variable instead of local tools for API profiles", async () => {
    await environment(["sox"]);
    const settings = {
      activeProfile: "remote",
      profiles: {
        remote: {
          type: "api" as const,
          endpoint: "https://stt.example.com",
          model: "whisper-1",
          apiKeyEnv: "VOICE_KEY",
        },
      },
    };
    vi.stubEnv("VOICE_KEY", "");
    expect((await runDoctor(settings)).map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: "sox", ok: true },
      { id: "api-key", ok: false },
    ]);
    expect((await runDoctor(settings)).at(-1)?.fix).toBe("set VOICE_KEY in your environment");
    vi.stubEnv("VOICE_KEY", "secret");
    expect((await runDoctor(settings)).at(-1)).toEqual({
      id: "api-key",
      ok: true,
      detail: "VOICE_KEY is set",
    });
  });

  it("verifies a saved input device is still connected", async () => {
    await environment(["sox"]);
    const settings = {
      inputDevice: mic,
      activeProfile: "remote",
      profiles: { remote: { type: "api" as const, endpoint: "https://x.test", model: "m" } },
    };
    expect(await runDoctor(settings, { listDevices: () => Promise.resolve([mic]) })).toContainEqual(
      { id: "device", ok: true, detail: "Mic" },
    );
    expect(await runDoctor(settings, { listDevices: () => Promise.resolve([]) })).toContainEqual({
      id: "device",
      ok: false,
      detail: "Mic is not connected",
      fix: "choose another input device",
    });
  });
});
