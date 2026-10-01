import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { symlink } from "vitest-testdirs/helpers";

import { discoverLocalModels, downloadModel, modelDir, modelPath } from "../src/models";

describe("discoverLocalModels", () => {
  it("finds ggml models sorted by name and skips other files", async () => {
    const dir = await testdir({
      "ggml-small.bin": "",
      "notes.txt": "",
      "ggml-base.bin": "",
      "model.bin": "",
    });
    expect(discoverLocalModels(dir)).toEqual([
      join(dir, "ggml-base.bin"),
      join(dir, "ggml-small.bin"),
    ]);
  });

  it("follows symlinked models but skips broken links", async () => {
    const dir = await testdir({
      store: { "ggml-real.bin": "" },
      models: {
        "ggml-linked.bin": symlink("../store/ggml-real.bin"),
        "ggml-broken.bin": symlink("../store/missing.bin"),
      },
    });
    expect(discoverLocalModels(join(dir, "models"))).toEqual([
      join(dir, "models", "ggml-linked.bin"),
    ]);
  });

  it("is empty for a missing directory", () => {
    expect(discoverLocalModels("/does/not/exist")).toEqual([]);
  });
});

describe("discoverLocalModels defaults", () => {
  it("looks only in ~/.cache/whisper", async () => {
    const dir = await testdir({
      ".cache": { whisper: { "ggml-turbo.bin": "" } },
      ".local": { share: { "whisper-cpp": { "ggml-base.bin": "" } } },
    });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(discoverLocalModels()).toEqual([join(dir, ".cache", "whisper", "ggml-turbo.bin")]);
  });

  it("looks only in AGENT_VOICE_MODEL_DIR when set", async () => {
    const dir = await testdir({
      custom: { "ggml-custom.bin": "" },
      ".cache": { whisper: { "ggml-turbo.bin": "" } },
    });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", join(dir, "custom"));
    expect(discoverLocalModels()).toEqual([join(dir, "custom", "ggml-custom.bin")]);
  });

  it("is empty when no model is installed", async () => {
    vi.stubEnv("HOME", await testdir({}));
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(discoverLocalModels()).toEqual([]);
  });
});

describe("modelDir", () => {
  it("defaults to ~/.cache/whisper", async () => {
    const dir = await testdir({});
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(modelDir()).toBe(join(dir, ".cache", "whisper"));
    expect(modelPath("base.en")).toBe(join(dir, ".cache", "whisper", "ggml-base.en.bin"));
  });

  it("uses AGENT_VOICE_MODEL_DIR when set", () => {
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "/models");
    expect(modelDir()).toBe("/models");
  });
});

/** A streaming response of `chunks`; `length` overrides the Content-Length header. */
function respond(chunks: string[], init: { status?: number; length?: number } = {}) {
  const bytes = chunks.map((chunk) => new TextEncoder().encode(chunk));
  const length = init.length ?? bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-length": String(length) },
  });
}

describe("downloadModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads from Hugging Face into the model directory and reports progress", async () => {
    const dir = await testdir({});
    const fetch = vi.fn(() => Promise.resolve(respond(["mod", "el"])));
    vi.stubGlobal("fetch", fetch);
    const progress: [number, number | undefined][] = [];

    const path = await downloadModel("base.en", {
      dir: join(dir, "models"),
      onProgress: (received, total) => {
        progress.push([received, total]);
      },
    });

    expect(path).toBe(join(dir, "models", "ggml-base.en.bin"));
    expect(readFileSync(path, "utf8")).toBe("model");
    expect(fetch).toHaveBeenCalledWith(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
      expect.anything(),
    );
    // Node may coalesce chunks, so only the final count is fixed.
    expect(progress.at(-1)).toEqual([5, 5]);
    expect(readdirSync(join(dir, "models"))).toEqual(["ggml-base.en.bin"]);
  });

  it("is discoverable once downloaded to the default directory", async () => {
    const dir = await testdir({});
    vi.stubEnv("HOME", dir);
    vi.stubGlobal("fetch", () => Promise.resolve(respond(["model"])));
    const path = await downloadModel("tiny.en");
    expect(discoverLocalModels()).toEqual([path]);
  });

  it("rejects names that could escape the directory", async () => {
    await expect(downloadModel("../evil")).rejects.toThrow("Invalid Whisper model name");
  });

  it("fails on HTTP errors without writing a file", async () => {
    const dir = await testdir({});
    vi.stubGlobal("fetch", () => Promise.resolve(respond(["nope"], { status: 404 })));
    await expect(downloadModel("missing", { dir })).rejects.toThrow(
      "Downloading missing failed: HTTP 404",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the partial file when the body ends early", async () => {
    const dir = await testdir({});
    vi.stubGlobal("fetch", () => Promise.resolve(respond(["mod"], { length: 5 })));
    await expect(downloadModel("base", { dir })).rejects.toThrow("ended early (3 of 5 bytes)");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the partial file when aborted mid-download", async () => {
    const dir = await testdir({});
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("mod"));
        // Never closes: the download only ends by aborting.
      },
    });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(body, { headers: { "content-length": "5" } })),
    );

    const download = downloadModel("base", {
      dir,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });

    await expect(download).rejects.toThrow(/abort/iu);
    expect(existsSync(join(dir, "ggml-base.bin.part"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
