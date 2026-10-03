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
const { settings, errors } = loadVoiceSettings(settingsPath);
if (!settings) {
  showSetup(errors);
  return;
}
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

`loadVoiceSettings` returns `{ settings, errors }`. A missing file returns `settings: undefined` with an empty error list. Invalid settings, malformed JSON, and read failures return no settings and errors containing a JSON-pointer `path` and `message`. Known fields are validated with TypeBox; extra keys are allowed and preserved. Loading never modifies the file. Hosts decide how to display errors and offer setup. `validateVoiceSettings` provides the same result for values already in memory.

## ⚙️ Settings

Saved settings require `activeProfile` and `profiles`. Omitting `inputDevice` uses the system-default microphone. A local profile without a model path uses an auto-discovered Whisper model. Name profiles and choose one explicitly:

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

## ⬇️ Models and doctor

```ts
import { downloadModel, listLocalModels, runDoctor } from "@luxass/agent-voice";

// Installed models, then curated downloads: { name, path, installed, approxMB? }
const picked = await pickOne(listLocalModels());
const model = picked.installed
  ? picked.path
  : await downloadModel(picked.name, { onProgress: (received, total) => show(received, total) });

// [{ id: "sox", ok: false, detail: "sox not found", fix: "brew install sox" }, ...]
for (const check of await runDoctor(settings)) report(check);
```

`downloadModel` fetches `ggml-<name>.bin` from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) into `modelDir()`: `$AGENT_VOICE_MODEL_DIR`, else `~/.cache/whisper`. It writes to a unique `.part` file and renames it when complete, so a failed or aborted download is never discovered as a model. Model discovery looks only in `modelDir()`, so a downloaded model is used without changing settings. Models elsewhere need `AGENT_VOICE_MODEL_DIR` or an explicit `model` path in the profile.

`runDoctor` checks what the active profile needs (`sox`, a saved input device, `whisper-cli` and a model for local profiles, the API key variable for API profiles) without recording or calling any API. Failed checks carry a `fix`: an install hint for the current platform, or a step worded in terms of profiles. Hosts can swap in their own command for an `id`, such as a model picker command for `model`.

## 🧰 Requirements

- Node.js >= 24
- `sox` on `PATH` for recording
- Local transcription: `whisper-cli` on `PATH` and a `ggml-*.bin` model (`downloadModel` can fetch one)
- API transcription needs no local Whisper installation

## 📄 License

Published under [MIT License](./LICENSE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-version-href]: https://npmjs.com/package/@luxass/agent-voice
[npm-downloads-src]: https://img.shields.io/npm/dm/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-downloads-href]: https://npmjs.com/package/@luxass/agent-voice
