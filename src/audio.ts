/**
 * Native capture produces mono PCM at 16 kHz, normalized to [-1, 1].
 */
export const AUDIO_SAMPLE_RATE = 16_000;

export type RecordedAudio = {
  sampleRate: typeof AUDIO_SAMPLE_RATE;
  pcm: Float32Array;
};

/**
 * Encode recorded PCM as a mono, 16-bit WAV buffer.
 *
 * @param {RecordedAudio} audio - Captured PCM and its sample rate.
 * @returns WAV bytes ready to save or upload.
 */
export function encodeWav({ sampleRate, pcm }: RecordedAudio): Buffer {
  const dataSize = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (const [index, sample] of pcm.entries()) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), 44 + index * 2);
  }
  return wav;
}
