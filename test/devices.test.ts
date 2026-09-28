import { describe, expect, it } from "vitest";

import {
  listInputDevices,
  parseAlsaPcm,
  parseMacInputs,
  parsePactlSources,
  parseWaveAudioInputs,
  resolvePreferredDevice,
  type InputDevice,
} from "../src/devices";

const device = (id: string): InputDevice => {
  const [format, ...rest] = id.split(":");
  return {
    id,
    name: rest.join(":"),
    format: format as InputDevice["format"],
    source: rest.join(":"),
  };
};

describe("parseMacInputs", () => {
  it("collects input device names and dedupes", () => {
    const stdout = JSON.stringify({
      SPAudioDataType: [
        {
          _items: [
            { _name: "Built-in Microphone", coreaudio_device_input: 1 },
            { coreaudio_device_name: "USB Mic", coreaudio_input_source: "line" },
            { _name: "Built-in Microphone", coreaudio_device_input: 1 },
            { _name: "Speakers" },
          ],
        },
      ],
    });
    expect(parseMacInputs(stdout)).toEqual([
      {
        id: "coreaudio:Built-in Microphone",
        name: "Built-in Microphone",
        format: "coreaudio",
        source: "Built-in Microphone",
      },
      { id: "coreaudio:USB Mic", name: "USB Mic", format: "coreaudio", source: "USB Mic" },
    ]);
  });
});

describe("parsePactlSources", () => {
  it("skips monitor sources", () => {
    const stdout = "0\talsa_input.pci\tmodule\n1\talsa_output.pci.monitor\tmodule\n";
    expect(parsePactlSources(stdout)).toEqual([
      {
        id: "pulseaudio:alsa_input.pci",
        name: "alsa_input.pci",
        format: "pulseaudio",
        source: "alsa_input.pci",
      },
    ]);
  });
});

describe("parseAlsaPcm", () => {
  it("extracts capture devices", () => {
    const pcm =
      "00-00: ALC257 Analog : ALC257 Analog : playback 1 : capture 1\n01-00: USB Audio : USB Audio : capture 1\n";
    expect(parseAlsaPcm(pcm)).toEqual([
      { id: "alsa:plughw:0,0", name: "ALC257 Analog", format: "alsa", source: "plughw:0,0" },
      { id: "alsa:plughw:1,0", name: "USB Audio", format: "alsa", source: "plughw:1,0" },
    ]);
  });
});

describe("parseWaveAudioInputs", () => {
  it("extracts enumerated devices", () => {
    const output =
      'Enumerating input device 0: "Microphone"\nEnumerating input device 1: "Line In"\n';
    expect(parseWaveAudioInputs(output)).toEqual([
      { id: "waveaudio:0", name: "Microphone", format: "waveaudio", source: "0" },
      { id: "waveaudio:1", name: "Line In", format: "waveaudio", source: "1" },
    ]);
  });
});

describe("listInputDevices", () => {
  it("throws on unsupported platforms", () => {
    expect(() => listInputDevices({ platform: "freebsd" })).toThrow("unsupported on freebsd");
  });

  it("lists mac inputs via system_profiler", async () => {
    const stdout = JSON.stringify({
      SPAudioDataType: [{ _items: [{ _name: "Mic", coreaudio_device_input: 2 }] }],
    });
    const devices = await listInputDevices({
      platform: "darwin",
      run: async () => ({ stdout, stderr: "" }),
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe("coreaudio:Mic");
  });

  it("falls back to ALSA when pactl fails", async () => {
    const devices = await listInputDevices({
      platform: "linux",
      run: async () => {
        throw new Error("pactl missing");
      },
      readProcAsound: async () => "00-00: ALC : ALC : capture 1\n",
    });
    expect(devices[0]?.format).toBe("alsa");
  });

  it("throws when neither pactl nor procfs is available", async () => {
    await expect(
      listInputDevices({
        platform: "linux",
        run: async () => {
          throw new Error("no pactl");
        },
        readProcAsound: async () => {
          throw new Error("no procfs");
        },
      }),
    ).rejects.toThrow("Cannot list Linux inputs");
  });

  it("throws when SoX lists no Windows inputs", async () => {
    const error = Object.assign(new Error("sox failed"), { stderr: "nothing here" });
    await expect(
      listInputDevices({
        platform: "win32",
        run: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow("SoX could not list WaveAudio inputs");
  });
});

describe("resolvePreferredDevice", () => {
  const devices = [device("coreaudio:Mic A"), device("pulseaudio:mic-b")];

  it("returns undefined device for empty preference", () => {
    expect(resolvePreferredDevice(devices, "")).toEqual({ device: undefined, warning: undefined });
  });

  it("matches by id, name, or source", () => {
    expect(resolvePreferredDevice(devices, "coreaudio:Mic A").device?.id).toBe("coreaudio:Mic A");
    expect(resolvePreferredDevice(devices, "Mic A").device?.id).toBe("coreaudio:Mic A");
    expect(resolvePreferredDevice(devices, "mic-b").device?.id).toBe("pulseaudio:mic-b");
  });

  it("falls back with a warning when the preference is gone", () => {
    const result = resolvePreferredDevice(devices, "coreaudio:Unplugged");
    expect(result.device?.id).toBe("coreaudio:Mic A");
    expect(result.warning).toContain("coreaudio:Unplugged is unavailable");
  });

  it("throws when nothing is available", () => {
    expect(() => resolvePreferredDevice([], "coreaudio:Unplugged")).toThrow(
      "No available input devices",
    );
  });
});
