# 🎙️ agent-voice

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

Host-independent audio recording, input device discovery, and Whisper transcription for Node.js.

## 📦 Installation

```sh
pnpm add @luxass/agent-voice
```

## 📚 Usage

```ts
import {
  createRecorder,
  getActiveProfile,
  listInputDevices,
  loadVoiceSettings,
  saveVoiceSettings,
  transcribe,
} from "@luxass/agent-voice";

// The host chooses where its settings file lives.
const settings = loadVoiceSettings(settingsPath);
const recorder = createRecorder();

// Recording uses the saved device directly, or the system default.
recorder.start(settings.inputDevice, (error) => notify(error.message));

// On the next invocation:
const file = await recorder.stop();
try {
  const text = await transcribe(file, getActiveProfile(settings).transcription);
  paste(text);
} finally {
  recorder.discard(file);
}

// List devices only when opening a device picker, then save the same object.
settings.inputDevice = (await listInputDevices())[0];
saveVoiceSettings(settingsPath, settings);
```

`loadVoiceSettings` validates once, without expanding paths or writing defaults. A missing file means no settings. Save the same object after edits. Unknown keys are rejected.

## ⚙️ Settings

Omitting everything uses the system-default microphone and an auto-discovered local Whisper model. For multiple transcription configurations, name profiles and choose one explicitly:

```json
{
  "activeProfile": "local",
  "profiles": {
    "local": {
      "type": "local",
      "model": "~/models/ggml-large.bin"
    },
    "remote": {
      "type": "api",
      "endpoint": "https://stt.example.com/v1",
      "model": "whisper-large-v3",
      "apiKeyEnv": "VOICE_API_KEY"
    }
  }
}
```

The model and binary may use `~/`. These paths are expanded only when the local CLI accesses them. If no local model is configured, model discovery runs only when local transcription starts. An API profile defaults to multipart requests; use `"format": "openrouter"` for OpenRouter JSON audio. API keys belong in environment variables, not settings.

The host's device picker can save an `inputDevice` returned by `listInputDevices()`. When omitted, SoX uses the system default. If a saved input disappears, recording fails rather than silently switching microphones.

## 🧰 Requirements

- Node.js >= 24
- `sox` on `PATH` for recording
- Local transcription: `whisper-cli` on `PATH` and a `ggml-*.bin` model
- API transcription needs no local Whisper installation

## 📄 License

Published under [MIT License](./LICENSE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-version-href]: https://npmjs.com/package/@luxass/agent-voice
[npm-downloads-src]: https://img.shields.io/npm/dm/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-downloads-href]: https://npmjs.com/package/@luxass/agent-voice
