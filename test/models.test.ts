import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { symlink } from "vitest-testdirs/helpers";

import { discoverLocalModels } from "../src/models";

describe("discoverLocalModels", () => {
  it("finds ggml models sorted by name and skips other files", async () => {
    const dir = await testdir({
      "ggml-small.bin": "",
      "notes.txt": "",
      "ggml-base.bin": "",
      "model.bin": "",
    });
    expect(discoverLocalModels([dir])).toEqual([
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
    expect(discoverLocalModels([join(dir, "models")])).toEqual([
      join(dir, "models", "ggml-linked.bin"),
    ]);
  });

  it("searches directories in order and ignores missing ones", async () => {
    const dir = await testdir({ first: { "ggml-b.bin": "" }, second: { "ggml-a.bin": "" } });
    expect(
      discoverLocalModels([join(dir, "first"), "/does/not/exist", join(dir, "second")]),
    ).toEqual([join(dir, "first", "ggml-b.bin"), join(dir, "second", "ggml-a.bin")]);
  });
});

describe("discoverLocalModels defaults", () => {
  it("prefers ~/.cache/whisper over ~/.local/share/whisper-cpp", async () => {
    const dir = await testdir({
      ".cache": { whisper: { "ggml-turbo.bin": "" } },
      ".local": { share: { "whisper-cpp": { "ggml-base.bin": "" } } },
    });
    vi.stubEnv("HOME", dir);
    expect(discoverLocalModels()).toEqual([
      join(dir, ".cache", "whisper", "ggml-turbo.bin"),
      join(dir, ".local", "share", "whisper-cpp", "ggml-base.bin"),
    ]);
  });

  it("is empty when no model is installed", async () => {
    vi.stubEnv("HOME", await testdir({}));
    expect(discoverLocalModels()).toEqual([]);
  });
});
