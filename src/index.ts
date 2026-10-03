export { AUDIO_SAMPLE_RATE, encodeWav } from "./audio";
export type { RecordedAudio } from "./audio";
export {
  getActiveProfile,
  loadVoiceSettings,
  saveVoiceSettings,
  transcriptionProfileSchema,
  validateVoiceSettings,
  voiceSettingsSchema,
} from "./config";
export type {
  TranscriptionProfile,
  VoiceSettings,
  VoiceSettingsError,
  VoiceSettingsResult,
} from "./config";
export { listInputDevices } from "./devices";
export type { InputDevice } from "./devices";
export { runDoctor } from "./doctor";
export type { DoctorOptions, DoctorCheck, DoctorCheckId } from "./doctor";
export {
  discoverLocalModels,
  downloadModel,
  listLocalModels,
  modelDir,
  modelPath,
  MODEL_CATALOG,
} from "./models";
export type { DownloadModelOptions, DownloadableModel, LocalModel } from "./models";
export { createRecorder } from "./recording";
export type { Recorder, RecordingOptions } from "./recording";
export { createTranscriber, transcribe } from "./transcription";
export type {
  Transcriber,
  TranscriptText,
  TranscriptionOptions,
  TranscriptionStream,
} from "./transcription";
