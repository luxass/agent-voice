import { Type } from "typebox";

export const inputDeviceSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
});

export type InputDevice = Type.Static<typeof inputDeviceSchema>;

/**
 * List native microphones without opening a device.
 *
 * @returns Device IDs and names, excluding loopback monitor sources.
 * @throws If the native binding cannot load or device enumeration fails.
 */
export async function listInputDevices(): Promise<InputDevice[]> {
  const { listInputDevices: listDevices } = await import("@handy-computer/recorder");
  return (await listDevices())
    .filter((device) => !device.isMonitor)
    .map(({ id, name }) => ({ id, name }));
}
