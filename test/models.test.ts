import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { symlink } from "vitest-testdirs/helpers";

import {
  discoverLocalModels,
  downloadModel,
  listLocalModels,
  MODEL_CATALOG,
  modelDir,
  modelPath,
} from "../src/models";

describe("discoverLocalModels", () => {
  it("finds GGUF models sorted by name and skips other files and directories", async () => {
    const dir = await testdir({
      "whisper-small.gguf": "",
      "notes.txt": "",
      "parakeet.gguf": "",
      "ggml-old.bin": "",
      "directory.gguf": {},
    });
    expect(discoverLocalModels(dir)).toEqual([
      join(dir, "parakeet.gguf"),
      join(dir, "whisper-small.gguf"),
    ]);
  });

  it("follows symlinked GGUF models but skips broken links", async () => {
    const dir = await testdir({
      store: { "real.gguf": "" },
      models: {
        "linked.gguf": symlink("../store/real.gguf"),
        "broken.gguf": symlink("../store/missing.gguf"),
      },
    });
    expect(discoverLocalModels(join(dir, "models"))).toEqual([join(dir, "models", "linked.gguf")]);
  });

  it("is empty for a missing directory", () => {
    expect(discoverLocalModels("/does/not/exist")).toEqual([]);
  });
});

describe("discoverLocalModels defaults", () => {
  it("looks only in ~/.cache/agent-voice", async () => {
    const dir = await testdir({
      ".cache": {
        "agent-voice": { "whisper-small.gguf": "" },
        whisper: { "old.gguf": "" },
      },
    });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(discoverLocalModels()).toEqual([
      join(dir, ".cache", "agent-voice", "whisper-small.gguf"),
    ]);
  });

  it("looks only in AGENT_VOICE_MODEL_DIR when set", async () => {
    const dir = await testdir({
      custom: { "custom.gguf": "" },
      ".cache": { "agent-voice": { "whisper-small.gguf": "" } },
    });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", join(dir, "custom"));
    expect(discoverLocalModels()).toEqual([join(dir, "custom", "custom.gguf")]);
  });

  it("is empty when no model is installed", async () => {
    vi.stubEnv("HOME", await testdir({}));
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(discoverLocalModels()).toEqual([]);
  });
});

describe("listLocalModels", () => {
  it("lists installed GGUF models first, then curated downloads that are not installed", async () => {
    const dir = await testdir({ "whisper-small.gguf": "", "custom.gguf": "" });
    const models = listLocalModels(dir);
    expect(models.slice(0, 2)).toEqual([
      { name: "custom", path: join(dir, "custom.gguf"), installed: true },
      { name: "whisper-small", path: join(dir, "whisper-small.gguf"), installed: true },
    ]);
    expect(models.slice(2)).toEqual(
      MODEL_CATALOG.filter(({ name }) => name !== "whisper-small").map(({ name, approxMB }) => ({
        name,
        path: join(dir, `${name}.gguf`),
        installed: false,
        approxMB,
      })),
    );
  });
});

describe("modelDir", () => {
  it("defaults to ~/.cache/agent-voice", async () => {
    const dir = await testdir({});
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    expect(modelDir()).toBe(join(dir, ".cache", "agent-voice"));
    expect(modelPath("whisper-small")).toBe(
      join(dir, ".cache", "agent-voice", "whisper-small.gguf"),
    );
  });

  it("uses AGENT_VOICE_MODEL_DIR when set", () => {
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "/models");
    expect(modelDir()).toBe("/models");
  });
});

function respond(chunks: string[]) {
  const bytes = chunks.map((chunk) => new TextEncoder().encode(chunk));
  const length = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-length": String(length) } });
}

describe("downloadModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads a pinned GGUF revision and reports progress", async () => {
    const dir = await testdir({});
    const fetch = vi.fn(() => Promise.resolve(respond(["mod", "el"])));
    vi.stubGlobal("fetch", fetch);
    const progress: [number, number | undefined][] = [];
    const path = await downloadModel("whisper-small", {
      dir: join(dir, "models"),
      onProgress: (received, total) => {
        progress.push([received, total]);
      },
    });
    expect(path).toBe(join(dir, "models", "whisper-small.gguf"));
    expect(readFileSync(path, "utf8")).toBe("model");
    expect(fetch).toHaveBeenCalledWith(
      "https://huggingface.co/handy-computer/whisper-small-gguf/resolve/c0214bd34be9296695486f838e0142f900803159/whisper-small-Q8_0.gguf",
      expect.anything(),
    );
    expect(progress.at(-1)).toEqual([5, 5]);
    expect(readdirSync(join(dir, "models"))).toEqual(["whisper-small.gguf"]);
  });

  it("is discoverable once downloaded to the default directory", async () => {
    vi.stubEnv("HOME", await testdir({}));
    vi.stubEnv("AGENT_VOICE_MODEL_DIR", "");
    vi.stubGlobal("fetch", () => Promise.resolve(respond(["model"])));
    const path = await downloadModel("whisper-small");
    expect(discoverLocalModels()).toEqual([path]);
  });

  it("rejects unknown names before fetching or writing files", async () => {
    const dir = await testdir({});
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(downloadModel("../evil", { dir })).rejects.toThrow(
      "Unknown downloadable model: ../evil",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails on HTTP errors without writing a file and releases the body", async () => {
    const dir = await testdir({});
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status: 404 })));
    await expect(downloadModel("whisper-small", { dir })).rejects.toThrow(
      "Downloading whisper-small failed: HTTP 404",
    );
    expect(cancel).toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps concurrent downloads of one model apart", async () => {
    const dir = await testdir({});
    vi.stubGlobal("fetch", () => Promise.resolve(respond(["mod", "el"])));
    const paths = await Promise.all([
      downloadModel("whisper-small", { dir }),
      downloadModel("whisper-small", { dir }),
    ]);
    expect(paths).toEqual([join(dir, "whisper-small.gguf"), join(dir, "whisper-small.gguf")]);
    expect(readFileSync(join(dir, "whisper-small.gguf"), "utf8")).toBe("model");
    expect(readdirSync(dir)).toEqual(["whisper-small.gguf"]);
  });

  it("removes the partial file when the connection fails mid-download", async () => {
    const dir = await testdir({});
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("mod"));
        stream.error(new Error("socket closed"));
      },
    });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body)));
    await expect(downloadModel("whisper-small", { dir })).rejects.toThrow("socket closed");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the partial file when aborted mid-download", async () => {
    const dir = await testdir({});
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("mod"));
      },
    });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(body, { headers: { "content-length": "5" } })),
    );
    const download = downloadModel("whisper-small", {
      dir,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(download).rejects.toThrow(/abort/iu);
    expect(readdirSync(dir)).toEqual([]);
  });
});
