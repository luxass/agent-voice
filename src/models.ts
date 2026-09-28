import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Well-known whisper.cpp model locations, in preference order.
 * Covers pi-style (`~/.cache/whisper`) and whisper-cpp-style
 * (`~/.local/share/whisper-cpp`) installs.
 */
export function defaultModelDirectories(): string[] {
  const home = homedir();
  return [join(home, ".cache", "whisper"), join(home, ".local", "share", "whisper-cpp")];
}

function ggmlFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && /^ggml-.*\.bin$/.test(entry.name),
    )
    .map((entry) => join(directory, entry.name))
    .filter(existsSync)
    .toSorted();
}

/** All installed models across the given directories (defaults to the well-known ones). */
export function discoverLocalModels(directories: string[] = defaultModelDirectories()): string[] {
  return directories.flatMap(ggmlFiles);
}

/** First installed model, if any. Used as the zero-config default. */
export function defaultLocalModel(): string | undefined {
  return discoverLocalModels()[0];
}
