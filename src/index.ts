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
  WHISPER_MODELS,
} from "./models";
export type { DownloadModelOptions, LocalModel, WhisperModel } from "./models";
export { createRecorder } from "./recording";
export type { Recorder } from "./recording";
export { transcribe } from "./transcription";
