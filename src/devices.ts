import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type InputDevice = {
  id: string;
  name: string;
  format: "coreaudio" | "pulseaudio" | "alsa" | "waveaudio";
  source: string;
};

export type RunFunction = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type ListInputDevicesOptions = {
  platform?: NodeJS.Platform;
  run?: RunFunction;
  readProcAsound?: () => Promise<string>;
};

const defaultRun: RunFunction = async (command, args) => {
  const run = promisify(execFile);
  const { stdout, stderr } = await run(command, args, { timeout: 5000 });
  return { stdout, stderr };
};

function device(format: InputDevice["format"], source: string, name = source): InputDevice {
  return { id: `${format}:${source}`, name, format, source };
}

// Keys mirror system_profiler JSON output and cannot be renamed.
type MacAudioItem = {
  coreaudio_device_name?: string;
  _name?: string;
  coreaudio_device_input?: number;
  coreaudio_input_source?: string;
};

/** Pure parser for `system_profiler -json SPAudioDataType` output. Exported for testing. */
export function parseMacInputs(stdout: string): InputDevice[] {
  const data: { SPAudioDataType: { _items?: MacAudioItem[] }[] } = JSON.parse(stdout);
  const names = new Set<string>();
  for (const group of data.SPAudioDataType) {
    // eslint-disable-next-line no-underscore-dangle -- system_profiler key
    for (const item of group._items ?? []) {
      // eslint-disable-next-line no-underscore-dangle -- system_profiler key
      const name = item.coreaudio_device_name ?? item._name;
      if (name && (item.coreaudio_device_input || item.coreaudio_input_source != null))
        names.add(name);
    }
  }
  return [...names].map((name) => device("coreaudio", name));
}

/** Pure parser for `pactl list sources short` output. Exported for testing. */
export function parsePactlSources(stdout: string): InputDevice[] {
  return stdout.split("\n").flatMap((line) => {
    const [, name] = line.split("\t");
    if (!name || name.endsWith(".monitor")) return [];
    return [device("pulseaudio", name)];
  });
}

/** Pure parser for `/proc/asound/pcm` content. Exported for testing. */
export function parseAlsaPcm(pcm: string): InputDevice[] {
  return pcm.split("\n").flatMap((line) => {
    const match = /^(\d+)-(\d+):\s*([^:]+):.*\bcapture\s+\d+/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) return [];
    return [device("alsa", `plughw:${Number(match[1])},${Number(match[2])}`, match[3].trim())];
  });
}

/** Pure parser for SoX WaveAudio debug output. Exported for testing. */
export function parseWaveAudioInputs(output: string): InputDevice[] {
  const inputs = new Map<string, InputDevice>();
  for (const match of output.matchAll(/Enumerating input device\s+(\d+):\s+"([^"]+)"/g)) {
    const [, id, name] = match;
    if (!id || !name) continue;
    inputs.set(id, device("waveaudio", id, name));
  }
  return [...inputs.values()];
}

async function macInputs(run: RunFunction): Promise<InputDevice[]> {
  const { stdout } = await run("system_profiler", ["-json", "SPAudioDataType"]);
  return parseMacInputs(stdout);
}

async function linuxInputs(
  run: RunFunction,
  readProcAsound: () => Promise<string>,
): Promise<InputDevice[]> {
  // PipeWire's PulseAudio compatibility layer uses the same source names.
  try {
    const { stdout } = await run("pactl", ["list", "sources", "short"]);
    const sources = parsePactlSources(stdout);
    if (sources.length) return sources;
  } catch {
    // pactl is optional; ALSA capture devices are available from procfs.
  }

  let pcm: string;
  try {
    pcm = await readProcAsound();
  } catch {
    throw new Error(
      "Cannot list Linux inputs: no PulseAudio sources or ALSA capture devices found",
    );
  }
  return parseAlsaPcm(pcm);
}

async function windowsInputs(run: RunFunction): Promise<InputDevice[]> {
  // SoX prints its own WaveAudio input IDs at debug level when a name cannot be found.
  // The probe deliberately fails before starting a recording.
  let output = "";
  try {
    await run("sox", ["-V6", "-t", "waveaudio", "agent-voice-missing-input", "-n"]);
  } catch (error) {
    if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string")
      throw error;
    output = error.stderr;
  }
  const inputs = parseWaveAudioInputs(output);
  if (!inputs.length) throw new Error("SoX could not list WaveAudio inputs");
  return inputs;
}

const defaultReadProcAsound = () => readFile("/proc/asound/pcm", "utf8");

export function listInputDevices(options: ListInputDevicesOptions = {}): Promise<InputDevice[]> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  switch (platform) {
    case "darwin":
      return macInputs(run);
    case "linux":
      return linuxInputs(run, options.readProcAsound ?? defaultReadProcAsound);
    case "win32":
      return windowsInputs(run);
    default:
      throw new Error(`Input device selection is unsupported on ${platform}`);
  }
}

export type PreferredDevice = {
  device: InputDevice | undefined;
  /** Warning for the host to display when falling back to another input. */
  warning: string | undefined;
};

/**
 * Match a saved `input` preference (device id, name, or source) against
 * discovered devices. Falls back to the first available input with a warning
 * instead of silently using the OS default. Hosts display `warning` themselves.
 */
export function resolvePreferredDevice(
  devices: InputDevice[],
  preference: string,
): PreferredDevice {
  if (!preference) return { device: undefined, warning: undefined };
  const selected = devices.find(
    (candidate) =>
      candidate.id === preference ||
      candidate.name === preference ||
      candidate.source === preference,
  );
  if (selected) return { device: selected, warning: undefined };
  const fallback = devices[0];
  if (!fallback) throw new Error("No available input devices");
  return {
    device: fallback,
    warning: `Input ${preference} is unavailable; using ${fallback.name}. Preference kept for next time`,
  };
}
