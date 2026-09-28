import { describe, expect, it } from "vitest";

import {
  defaultModel,
  resolveOptions,
  transcriptionProfile,
  type VoiceConfig,
} from "../src/config";

const active = (config: VoiceConfig) => transcriptionProfile(config, config.activeTranscription);

describe("resolveOptions", () => {
  it("defaults to local transcription with system defaults", () => {
    const config = resolveOptions({});
    expect(config.input).toBe("");
    expect(config.activeTranscription).toBe("default");
    const transcription = active(config);
    expect(transcription.type).toBe("local");
    if (transcription.type === "local") {
      expect(transcription.binary).toBe("whisper-cli");
      expect(transcription.language).toBe("auto");
      // Zero-config default: discovered install, or the historical fallback path.
      expect(transcription.model.length).toBeGreaterThan(0);
    }
  });

  it("trims the input preference", () => {
    const config = resolveOptions({ input: "  coreaudio:Built-in  " });
    expect(config.input).toBe("coreaudio:Built-in");
  });

  it("treats empty input as the system default", () => {
    expect(resolveOptions({ input: "" }).input).toBe("");
    expect(resolveOptions({ input: "   " }).input).toBe("");
    expect(resolveOptions({}).input).toBe("");
  });

  it("rejects non-string input", () => {
    expect(() => resolveOptions({ input: 42 })).toThrow("input must be a non-empty string");
  });

  it("expands ~ in local model paths", () => {
    const config = resolveOptions({
      transcriptions: { default: { type: "local", model: "~/models/ggml-base.bin" } },
    });
    const transcription = active(config);
    expect(transcription.type).toBe("local");
    if (transcription.type === "local") {
      expect(transcription.model).not.toContain("~");
      expect(transcription.model).toContain("models/ggml-base.bin");
    }
  });

  it("rejects unknown transcription types", () => {
    expect(() => resolveOptions({ transcriptions: { default: { type: "remote" } } })).toThrow(
      "transcriptions.default.type must be local or api",
    );
  });

  it("parses api transcription config", () => {
    const config = resolveOptions({
      transcriptions: {
        default: {
          type: "api",
          endpoint: "https://stt.example.com/v1/",
          models: ["whisper-large-v3-turbo", "whisper-small"],
          apiKeyEnv: "VOICE_STT_API_KEY",
        },
      },
    });
    expect(active(config)).toEqual({
      type: "api",
      endpoint: "https://stt.example.com/v1",
      models: ["whisper-large-v3-turbo", "whisper-small"],
      apiKeyEnv: "VOICE_STT_API_KEY",
      format: "multipart",
    });
  });

  it("rejects non-http endpoints", () => {
    expect(() =>
      resolveOptions({
        transcriptions: { default: { type: "api", endpoint: "ftp://x", models: ["m"] } },
      }),
    ).toThrow("transcriptions.default.endpoint must use HTTP or HTTPS");
  });

  it("rejects invalid api format", () => {
    expect(() =>
      resolveOptions({
        transcriptions: {
          default: { type: "api", endpoint: "https://x", models: ["m"], format: "grpc" },
        },
      }),
    ).toThrow("transcriptions.default.format must be multipart or openrouter");
  });

  it("deduplicates api models", () => {
    const config = resolveOptions({
      transcriptions: {
        default: { type: "api", endpoint: "https://x", models: ["m", "m2"] },
      },
    });
    const transcription = active(config);
    if (transcription.type === "api") {
      expect(transcription.models).toEqual(["m", "m2"]);
    } else {
      throw new Error("expected api config");
    }
  });

  it("parses named profiles with an explicit active profile", () => {
    const config = resolveOptions({
      activeTranscription: "syv",
      transcriptions: {
        syv: {
          type: "api",
          endpoint: "https://stt.example.com/v1",
          models: ["syv-transcribe"],
        },
        local: { type: "local", model: "~/models/ggml-base.bin" },
      },
    });
    expect(config.activeTranscription).toBe("syv");
    expect(Object.keys(config.transcriptions).toSorted()).toEqual(["local", "syv"]);
    const transcription = active(config);
    expect(transcription.type).toBe("api");
  });

  it("defaults the active profile to the first one", () => {
    const config = resolveOptions({
      transcriptions: {
        local: { type: "local", model: "~/models/ggml-base.bin" },
        syv: { type: "api", endpoint: "https://x", models: ["m"] },
      },
    });
    expect(config.activeTranscription).toBe("local");
  });

  it("rejects an unknown active profile", () => {
    expect(() =>
      resolveOptions({
        activeTranscription: "nope",
        transcriptions: { a: { type: "local", model: "m" } },
      }),
    ).toThrow("Unknown transcription profile: nope");
  });

  it("rejects empty and malformed profile maps", () => {
    expect(() => resolveOptions({ transcriptions: {} })).toThrow("at least one");
    expect(() => resolveOptions({ transcriptions: [] })).toThrow("must be an object");
    expect(() => resolveOptions({ transcriptions: { a: "nope" } })).toThrow(
      "transcriptions.a must be an object",
    );
  });

  it("rejects missing or empty api models", () => {
    expect(() =>
      resolveOptions({ transcriptions: { default: { type: "api", endpoint: "https://x" } } }),
    ).toThrow("transcriptions.default.models must be a non-empty list of model IDs");
    expect(() =>
      resolveOptions({
        transcriptions: { default: { type: "api", endpoint: "https://x", models: [] } },
      }),
    ).toThrow("transcriptions.default.models must be a non-empty list of model IDs");
  });

  it("dedupes api models keeping the default first", () => {
    const config = resolveOptions({
      transcriptions: {
        default: { type: "api", endpoint: "https://x", models: ["m", "m", "m2"] },
      },
    });
    expect(transcriptionProfile(config, "default")).toMatchObject({ models: ["m", "m2"] });
  });
});

describe("defaultModel", () => {
  it("returns the configured local path", () => {
    const config = resolveOptions({
      transcriptions: { default: { type: "local", model: "/m/ggml.bin" } },
    });
    expect(defaultModel(transcriptionProfile(config, "default"))).toBe("/m/ggml.bin");
  });

  it("returns the first api model", () => {
    const config = resolveOptions({
      transcriptions: { default: { type: "api", endpoint: "https://x", models: ["a", "b"] } },
    });
    expect(defaultModel(transcriptionProfile(config, "default"))).toBe("a");
  });
});

describe("transcriptionProfile", () => {
  it("throws on unknown names", () => {
    const config = resolveOptions({});
    expect(() => transcriptionProfile(config, "nope")).toThrow(
      "Unknown transcription profile: nope",
    );
  });
});
