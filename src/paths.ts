import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~/` to the user's home directory.
 *
 * @param {string} path - Path to access.
 * @returns The expanded path, or the original path when it has no `~/` prefix.
 */
export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
