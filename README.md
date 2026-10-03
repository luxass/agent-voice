# 🎙️ agent-voice

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

Host-independent native microphone capture, input device discovery, and local or API transcription.

## 📦 Installation

```sh
pnpm add @luxass/agent-voice
```

## 📚 Usage

```ts
import {
  createRecorder,
  createTranscriber,
  getActiveProfile,
  loadVoiceSettings,
} from "@luxass/agent-voice";

const { settings, errors } = loadVoiceSettings(settingsPath);
if (!settings) {
  showSetup(errors);
  return;
}
const recorder = await createRecorder();
const transcriber = await createTranscriber(getActiveProfile(settings).transcription);

// When dictation starts:
await recorder.start({
  input: settings.inputDevice,
  onError: (error) => notify(error.message),
});

// When dictation ends:
const audio = await recorder.stop();
paste(await transcriber.transcribe(audio));

// When the host shuts down:
transcriber.dispose();
```

## ⚙️ Settings

```json
{
  "activeProfile": "local",
  "profiles": {
    "local": {
      "type": "local",
      "model": "~/models/whisper-small.gguf"
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

## 📄 License

Published under [MIT License](./LICENSE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-version-href]: https://npmjs.com/package/@luxass/agent-voice
[npm-downloads-src]: https://img.shields.io/npm/dm/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-downloads-href]: https://npmjs.com/package/@luxass/agent-voice
