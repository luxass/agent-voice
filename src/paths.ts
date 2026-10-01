import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Settings keep `~/` paths as written; expand them only when a path is accessed. */
export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `command` the way `spawn` would: a path (or `~/` path) is checked directly,
 * a bare name is searched on `PATH`. Returns undefined when nothing executable is found.
 */
export function findExecutable(command: string): string | undefined {
  const expanded = expandHome(command);
  if (expanded.includes("/") || expanded.includes("\\"))
    return isExecutable(expanded) ? expanded : undefined;
  const extensions =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}
