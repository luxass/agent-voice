import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { Type } from "typebox";

export const inputDeviceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  format: Type.Union([
    Type.Literal("coreaudio"),
    Type.Literal("pulseaudio"),
    Type.Literal("alsa"),
    Type.Literal("waveaudio"),
  ]),
  source: Type.String(),
});

export type InputDevice = Type.Static<typeof inputDeviceSchema>;

type RunFunction = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

type ListInputDevicesOptions = {
  platform?: NodeJS.Platform;
  run?: RunFunction;
  readProcAsound?: () => Promise<string>;
};

// oxlint-disable-next-line typescript/strict-void-return -- node-style callback API, not a void callback
const execFileAsync = promisify(execFile);

const defaultRun: RunFunction = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
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

/** Parses `system_profiler -json SPAudioDataType` output. */
function parseMacInputs(stdout: string): InputDevice[] {
  const data = JSON.parse(stdout) as { SPAudioDataType: { _items?: MacAudioItem[] }[] };
  const names = new Set<string>();
  for (const group of data.SPAudioDataType) {
    // eslint-disable-next-line no-underscore-dangle -- system_profiler key
    for (const item of group._items ?? []) {
      // eslint-disable-next-line no-underscore-dangle -- system_profiler key
      const name = item.coreaudio_device_name ?? item._name;
      const isInput = (item.coreaudio_device_input ?? 0) > 0 || item.coreaudio_input_source != null;
      if (name != null && name !== "" && isInput) names.add(name);
    }
  }
  return [...names].map((name) => device("coreaudio", name));
}

/** Parses `pactl list sources short` output. */
function parsePactlSources(stdout: string): InputDevice[] {
  return stdout.split("\n").flatMap((line) => {
    const [, name] = line.split("\t");
    if (name == null || name === "" || name.endsWith(".monitor")) return [];
    return [device("pulseaudio", name)];
  });
}

/** Parses `/proc/asound/pcm` content. */
function parseAlsaPcm(pcm: string): InputDevice[] {
  return pcm.split("\n").flatMap((line) => {
    const [, card, pcmDevice, name] = /^(\d+)-(\d+):\s*([^:]+):.*\bcapture\s+\d+/u.exec(line) ?? [];
    if (card == null || pcmDevice == null || name == null) return [];
    return [device("alsa", `plughw:${Number(card)},${Number(pcmDevice)}`, name.trim())];
  });
}

/** Parses SoX WaveAudio debug output. */
function parseWaveAudioInputs(output: string): InputDevice[] {
  const inputs = new Map<string, InputDevice>();
  for (const match of output.matchAll(/Enumerating input device\s+(\d+):\s+"([^"]+)"/gu)) {
    const [, id, name] = match;
    if (id == null || name == null) continue;
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
    if (sources.length > 0) return sources;
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
  if (inputs.length === 0) throw new Error("SoX could not list WaveAudio inputs");
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
