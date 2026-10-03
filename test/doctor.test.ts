import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";

import type { VoiceSettings } from "../src/config";
import type { InputDevice } from "../src/devices";
import { runDoctor } from "../src/doctor";

const native = vi.hoisted(() => ({
  listInputDevices: vi.fn<() => Promise<{ id: string; name: string; isMonitor: boolean }[]>>(),
  getAvailableBackends: vi.fn<() => { name: string }[]>(),
}));

vi.mock("@handy-computer/recorder", () => ({
  listInputDevices: native.listInputDevices,
}));
vi.mock("transcribe-cpp", () => ({
  getAvailableBackends: native.getAvailableBackends,
}));

const mic: InputDevice = { id: "mic-id", name: "Mic" };

async function environment(files: Parameters<typeof testdir>[0] = {}) {
  const dir = await testdir(files);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("PATH", "");
  vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
  return dir;
}

beforeEach(() => {
  native.listInputDevices.mockReset().mockResolvedValue([{ ...mic, isMonitor: false }]);
  native.getAvailableBackends.mockReset().mockReturnValue([{ name: "CPU" }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runDoctor", () => {
  it("passes native capture and inference with a discovered GGUF model and no CLI tools", async () => {
    const dir = await environment({
      ".cache": { "agent-voice": { "whisper-small.gguf": "" } },
    });
    expect(await runDoctor()).toEqual([
      { id: "device", ok: true, detail: "System default input" },
      { id: "inference", ok: true, detail: "CPU" },
      {
        id: "model",
        ok: true,
        detail: join(dir, ".cache", "agent-voice", "whisper-small.gguf"),
      },
    ]);
  });

  it("reports missing microphones, inference bindings and models", async () => {
    await environment();
    native.listInputDevices.mockResolvedValue([]);
    native.getAvailableBackends.mockImplementation(() => {
      throw new Error("Native inference binding missing");
    });
    expect(await runDoctor()).toEqual([
      {
        id: "device",
        ok: false,
        detail: "No input devices found",
        fix: "connect a microphone",
      },
      {
        id: "inference",
        ok: false,
        detail: "Native inference binding missing",
        fix: `check native inference support for ${process.platform}/${process.arch}`,
      },
      {
        id: "model",
        ok: false,
        detail: "No GGUF model found",
        fix: "choose or download a model for profile local",
      },
    ]);
  });

  it("rejects local inference under Bun without loading the native binding", async () => {
    await environment();
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, bun: "1.4.2" },
    });
    expect(await runDoctor()).toContainEqual({
      id: "inference",
      ok: false,
      detail: "transcribe-cpp 0.2.4 is not supported in Bun",
      fix: "use an API profile",
    });
    expect(native.getAvailableBackends).not.toHaveBeenCalled();
  });

  it("reports a native binding with no registered inference backends", async () => {
    await environment();
    native.getAvailableBackends.mockReturnValue([]);
    expect(await runDoctor()).toContainEqual({
      id: "inference",
      ok: false,
      detail: "No native inference backends found",
      fix: "check native inference support for this platform",
    });
  });

  it("checks a configured GGUF model path, expanding ~/", async () => {
    await environment({ models: { "custom.gguf": "" } });
    const settings: VoiceSettings = {
      activeProfile: "local",
      profiles: { local: { type: "local", model: "~/models/custom.gguf" } },
    };
    expect(await runDoctor(settings)).toContainEqual({
      id: "model",
      ok: true,
      detail: "~/models/custom.gguf",
    });
    settings.profiles.local = { type: "local", model: "~/gone.gguf" };
    expect(await runDoctor(settings)).toContainEqual({
      id: "model",
      ok: false,
      detail: "~/gone.gguf does not exist",
      fix: "choose or download a model for profile local",
    });
  });

  it("checks API key variables without loading local inference", async () => {
    await environment();
    const settings: VoiceSettings = {
      activeProfile: "remote",
      profiles: {
        remote: {
          type: "api",
          endpoint: "https://stt.example.com",
          model: "whisper-1",
          apiKeyEnv: "VOICE_KEY",
        },
      },
    };
    vi.stubEnv("VOICE_KEY", "");
    expect((await runDoctor(settings)).map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: "device", ok: true },
      { id: "api-key", ok: false },
    ]);
    expect((await runDoctor(settings)).at(-1)?.fix).toBe("set VOICE_KEY in your environment");
    vi.stubEnv("VOICE_KEY", "secret");
    expect((await runDoctor(settings)).at(-1)).toEqual({
      id: "api-key",
      ok: true,
      detail: "VOICE_KEY is set",
    });
    expect(native.getAvailableBackends).not.toHaveBeenCalled();
  });

  it("verifies a saved microphone is still connected", async () => {
    await environment();
    const settings: VoiceSettings = {
      inputDevice: mic,
      activeProfile: "remote",
      profiles: { remote: { type: "api", endpoint: "https://x.test", model: "m" } },
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

  it("reports native microphone enumeration errors as diagnostics", async () => {
    await environment();
    native.listInputDevices.mockRejectedValue(new Error("Capture binding unavailable"));
    expect(await runDoctor()).toContainEqual({
      id: "device",
      ok: false,
      detail: "Capture binding unavailable",
      fix: `check native recorder support for ${process.platform}/${process.arch}`,
    });
  });

  it("rejects old whisper.cpp binary models", async () => {
    await environment({ models: { "ggml-old.bin": "" } });
    expect(
      await runDoctor({
        activeProfile: "local",
        profiles: { local: { type: "local", model: "~/models/ggml-old.bin" } },
      }),
    ).toContainEqual({
      id: "model",
      ok: false,
      detail: "~/models/ggml-old.bin is not a GGUF model",
      fix: "choose or download a model for profile local",
    });
  });
});
