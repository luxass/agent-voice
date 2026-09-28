import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultModelDirectories, discoverLocalModels } from "../src/models";

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function dirWith(files: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "agent-voice-models-"));
  for (const file of files) writeFileSync(join(dir, file), Buffer.alloc(10));
  return dir;
}

describe("discoverLocalModels", () => {
  it("finds ggml models and skips other files", () => {
    const found = discoverLocalModels([dirWith(["ggml-base.bin", "notes.txt", "ggml-small.bin"])]);
    expect(found).toEqual([
      join(dir as string, "ggml-base.bin"),
      join(dir as string, "ggml-small.bin"),
    ]);
  });

  it("returns empty for missing directories", () => {
    expect(discoverLocalModels(["/does/not/exist"])).toEqual([]);
  });

  it("searches directories in order", () => {
    const first = dirWith(["ggml-b.bin"]);
    const second = mkdtempSync(join(tmpdir(), "agent-voice-models-"));
    writeFileSync(join(second, "ggml-a.bin"), Buffer.alloc(10));
    const found = discoverLocalModels([first, second]);
    expect(found).toEqual([join(first, "ggml-b.bin"), join(second, "ggml-a.bin")]);
    rmSync(second, { recursive: true, force: true });
  });

  it("covers the pi-style and whisper-cpp-style locations", () => {
    expect(defaultModelDirectories().length).toBeGreaterThan(0);
    expect(defaultModelDirectories().some((d) => d.endsWith(join(".cache", "whisper")))).toBe(true);
  });
});
