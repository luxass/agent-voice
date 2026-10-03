import { beforeEach, describe, expect, it, vi } from "vitest";

import { listInputDevices } from "../src/devices";

const native = vi.hoisted(() => ({
  listInputDevices: vi.fn<() => Promise<{ id: string; name: string; isMonitor: boolean }[]>>(),
}));

vi.mock("@handy-computer/recorder", () => ({
  listInputDevices: native.listInputDevices,
}));

beforeEach(() => {
  native.listInputDevices.mockReset();
});

describe("listInputDevices", () => {
  it("preserves native microphone IDs and names", async () => {
    native.listInputDevices.mockResolvedValue([
      { id: "built-in-id", name: "Built-in Microphone", isMonitor: false },
      { id: "usb-id", name: "USB Mic", isMonitor: false },
    ]);
    await expect(listInputDevices()).resolves.toEqual([
      { id: "built-in-id", name: "Built-in Microphone" },
      { id: "usb-id", name: "USB Mic" },
    ]);
  });

  it("preserves distinct IDs for microphones with identical names", async () => {
    native.listInputDevices.mockResolvedValue([
      { id: "usb-one", name: "USB Mic", isMonitor: false },
      { id: "usb-two", name: "USB Mic", isMonitor: false },
    ]);
    await expect(listInputDevices()).resolves.toEqual([
      { id: "usb-one", name: "USB Mic" },
      { id: "usb-two", name: "USB Mic" },
    ]);
  });

  it("does not rebuild IDs from the enumeration order", async () => {
    const mic = { id: "mic-id", name: "Mic", isMonitor: false };
    const other = { id: "other-id", name: "Other", isMonitor: false };
    native.listInputDevices.mockResolvedValueOnce([mic, other]);
    const first = await listInputDevices();
    native.listInputDevices.mockResolvedValueOnce([other, mic]);
    const second = await listInputDevices();
    expect(first.find(({ name }) => name === "Mic")).toEqual(
      second.find(({ name }) => name === "Mic"),
    );
  });

  it("excludes loopback monitor sources from microphone choices", async () => {
    native.listInputDevices.mockResolvedValue([
      { id: "mic-id", name: "Mic", isMonitor: false },
      { id: "monitor-id", name: "Monitor of speakers", isMonitor: true },
    ]);
    await expect(listInputDevices()).resolves.toEqual([{ id: "mic-id", name: "Mic" }]);
  });

  it("returns an empty list when no microphones are available", async () => {
    native.listInputDevices.mockResolvedValue([]);
    await expect(listInputDevices()).resolves.toEqual([]);
  });

  it("propagates native enumeration failures", async () => {
    native.listInputDevices.mockRejectedValue(new Error("Native recorder unavailable"));
    await expect(listInputDevices()).rejects.toThrow("Native recorder unavailable");
  });
});
