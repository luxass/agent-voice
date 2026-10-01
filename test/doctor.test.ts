import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
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

describe("runDoctor", () => {
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
        detail: `${join(dir, ".cache", "whisper", "ggml-base.en.bin")} (auto-detected)`,
      },
    ]);
  });

  it("reports missing tools and models with fixes", async () => {
    await environment([]);
    expect(await runDoctor({})).toEqual([
      { id: "sox", ok: false, detail: "sox not found" },
      { id: "whisper-cli", ok: false, detail: "whisper-cli not found" },
      { id: "model", ok: false, detail: "No Whisper model found" },
    ]);
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
    });
    expect(
      await runDoctor(settings, { listDevices: () => Promise.reject(new Error("no pactl")) }),
    ).toContainEqual({ id: "device", ok: false, detail: "Cannot list inputs: no pactl" });
  });
});
