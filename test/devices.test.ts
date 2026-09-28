import { describe, expect, it } from "vitest";

import { listInputDevices } from "../src/devices";

/** A `run` that prints `stdout` for every command. */
const printing = (stdout: string) => () => Promise.resolve({ stdout, stderr: "" });

/** A `run` that fails every command with `error`. */
const failing = (error: Error) => () => Promise.reject(error);

describe("listInputDevices", () => {
  it("throws on unsupported platforms", () => {
    expect(() => listInputDevices({ platform: "freebsd" })).toThrow("unsupported on freebsd");
  });

  it("collects mac input device names from system_profiler and dedupes", async () => {
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
    await expect(listInputDevices({ platform: "darwin", run: printing(stdout) })).resolves.toEqual([
      {
        id: "coreaudio:Built-in Microphone",
        name: "Built-in Microphone",
        format: "coreaudio",
        source: "Built-in Microphone",
      },
      { id: "coreaudio:USB Mic", name: "USB Mic", format: "coreaudio", source: "USB Mic" },
    ]);
  });

  it("lists pactl sources on linux, skipping monitors", async () => {
    const stdout = "0\talsa_input.pci\tmodule\n1\talsa_output.pci.monitor\tmodule\n";
    await expect(listInputDevices({ platform: "linux", run: printing(stdout) })).resolves.toEqual([
      {
        id: "pulseaudio:alsa_input.pci",
        name: "alsa_input.pci",
        format: "pulseaudio",
        source: "alsa_input.pci",
      },
    ]);
  });

  it("falls back to ALSA capture devices when pactl fails", async () => {
    const pcm =
      "00-00: ALC257 Analog : ALC257 Analog : playback 1 : capture 1\n01-00: USB Audio : USB Audio : capture 1\n02-00: HDMI : HDMI : playback 1\n";
    await expect(
      listInputDevices({
        platform: "linux",
        run: failing(new Error("pactl missing")),
        readProcAsound: () => Promise.resolve(pcm),
      }),
    ).resolves.toEqual([
      { id: "alsa:plughw:0,0", name: "ALC257 Analog", format: "alsa", source: "plughw:0,0" },
      { id: "alsa:plughw:1,0", name: "USB Audio", format: "alsa", source: "plughw:1,0" },
    ]);
  });

  it("throws when neither pactl nor procfs is available", async () => {
    await expect(
      listInputDevices({
        platform: "linux",
        run: failing(new Error("no pactl")),
        readProcAsound: () => Promise.reject(new Error("no procfs")),
      }),
    ).rejects.toThrow("Cannot list Linux inputs");
  });

  it("lists windows inputs from SoX's WaveAudio debug output", async () => {
    const stderr =
      'Enumerating input device 0: "Microphone"\nEnumerating input device 1: "Line In"\n';
    const error = Object.assign(new Error("sox failed"), { stderr });
    await expect(listInputDevices({ platform: "win32", run: failing(error) })).resolves.toEqual([
      { id: "waveaudio:0", name: "Microphone", format: "waveaudio", source: "0" },
      { id: "waveaudio:1", name: "Line In", format: "waveaudio", source: "1" },
    ]);
  });

  it("throws when SoX lists no Windows inputs", async () => {
    const error = Object.assign(new Error("sox failed"), { stderr: "nothing here" });
    await expect(listInputDevices({ platform: "win32", run: failing(error) })).rejects.toThrow(
      "SoX could not list WaveAudio inputs",
    );
  });
});
