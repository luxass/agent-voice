export function isUnsupportedBun(): boolean {
  const version = process.versions.bun;
  if (version == null) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 1 || (major === 1 && minor < 4);
}
