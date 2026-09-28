import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function ggmlFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && /^ggml-.*\.bin$/u.test(entry.name),
    )
    .map((entry) => join(directory, entry.name))
    .filter((path) => existsSync(path))
    .toSorted();
}

/**
 * All installed whisper.cpp models across `directories`. Defaults to the well-known
 * locations in preference order: pi-style (`~/.cache/whisper`), then whisper-cpp-style
 * (`~/.local/share/whisper-cpp`). The first result is the zero-config default model.
 */
export function discoverLocalModels(
  directories = [
    join(homedir(), ".cache", "whisper"),
    join(homedir(), ".local", "share", "whisper-cpp"),
  ],
): string[] {
  return directories.flatMap((directory) => ggmlFiles(directory));
}
