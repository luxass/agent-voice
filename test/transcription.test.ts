import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import { metadata } from "vitest-testdirs/helpers";

import type { TranscriptionProfile } from "../src/config";
import { transcribe } from "../src/transcription";

/** An executable Node script standing in for whisper-cli. */
const node = (body: string) => metadata(`#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });

const HELLO = String.raw`process.stdout.write("  hello\nworld  ");`;

/** A test directory with a fake whisper-cli, a model file and a 100-byte recording. */
async function fixture(whisper = HELLO) {
  const dir = await testdir({
    "whisper-cli": node(whisper),
    "ggml-test.bin": "model",
    "rec.wav": new Uint8Array(100),
    "empty.wav": new Uint8Array(10),
  });
  return {
    dir,
    whisper: join(dir, "whisper-cli"),
    model: join(dir, "ggml-test.bin"),
    wav: join(dir, "rec.wav"),
    emptyWav: join(dir, "empty.wav"),
  };
}

const local = (binary: string, model: string, language?: string): TranscriptionProfile => ({
  type: "local",
  binary,
  model,
  language,
});

describe("local transcription", () => {
  it("resolves normalized text on success", async () => {
    const { whisper, model, wav } = await fixture();
    await expect(transcribe(wav, local(whisper, model))).resolves.toBe("hello world");
  });

  it("passes the model, recording and language to whisper-cli", async () => {
    const { whisper, model, wav } = await fixture(
      `process.stdout.write(process.argv.slice(2).join(" "));`,
    );
    await expect(transcribe(wav, local(whisper, model, "da"))).resolves.toBe(
      `-m ${model} -f ${wav} -l da -np -nt`,
    );
  });

  it("expands ~/ in the model and binary paths when spawning", async () => {
    const { dir, wav } = await fixture(`process.stdout.write(process.argv[3]);`);
    vi.stubEnv("HOME", dir);
    await expect(transcribe(wav, local("~/whisper-cli", "~/ggml-test.bin"))).resolves.toBe(
      join(dir, "ggml-test.bin"),
    );
  });

  it("rejects empty and missing recordings", async () => {
    const { whisper, model, emptyWav } = await fixture();
    await expect(transcribe(emptyWav, local(whisper, model))).rejects.toThrow("Recording is empty");
    await expect(transcribe("/does/not/exist.wav", local(whisper, model))).rejects.toThrow(
      "Recording is empty",
    );
  });

  it("rejects a missing model with the configured path", async () => {
    const { whisper, wav } = await fixture();
    await expect(transcribe(wav, local(whisper, "~/nope/ggml.bin"))).rejects.toThrow(
      "Whisper model not found at ~/nope/ggml.bin",
    );
  });

  it("rejects without a model when none is installed", async () => {
    const { dir, wav } = await fixture();
    vi.stubEnv("HOME", dir);
    await expect(transcribe(wav, { type: "local" })).rejects.toThrow(
      "No Whisper model found; download one or configure a local model",
    );
  });

  it("rejects a missing binary", async () => {
    const { model, wav } = await fixture();
    await expect(transcribe(wav, local("/does/not/exist-whisper", model))).rejects.toThrow(
      "ENOENT",
    );
  });

  it("rejects with the last stderr line on failure", async () => {
    const { whisper, model, wav } = await fixture(String.raw`
process.stderr.write("loading\nwhisper FAIL: bad file\n");
process.exit(1);`);
    await expect(transcribe(wav, local(whisper, model))).rejects.toThrow("whisper FAIL: bad file");
  });

  it("maps unknown-language errors", async () => {
    const { whisper, model, wav } = await fixture(String.raw`
process.stderr.write("error: unknown language 'xx'\n");
process.exit(1);`);
    await expect(transcribe(wav, local(whisper, model))).rejects.toThrow(
      "Unknown whisper language: xx",
    );
  });

  it("rejects empty output as no speech", async () => {
    const { whisper, model, wav } = await fixture("");
    await expect(transcribe(wav, local(whisper, model))).rejects.toThrow("No speech detected");
  });

  it("kills the subprocess on timeout", async () => {
    const { whisper, model, wav } = await fixture("setInterval(() => {}, 1000);");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const timedOut = expect(transcribe(wav, local(whisper, model))).rejects.toThrow(
      "Transcription timed out (60s)",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await timedOut;
  });
});

/** A local transcription API that answers every request with `payload`. Closed after the test. */
async function apiServer(payload: unknown, status = 200) {
  const requests: { url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`, requests };
}

describe("api transcription", () => {
  it("posts multipart to /audio/transcriptions and returns trimmed text", async () => {
    const { wav } = await fixture();
    const server = await apiServer({ text: "  hello  " });
    await expect(
      transcribe(wav, { type: "api", endpoint: server.url, model: "whisper-1" }),
    ).resolves.toBe("hello");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/v1/audio/transcriptions");
    expect(server.requests[0]?.headers["content-type"]).toContain("multipart/form-data");
    expect(server.requests[0]?.body.toString()).toContain("whisper-1");
  });

  it("posts openrouter JSON with base64 audio", async () => {
    const { wav } = await fixture();
    const server = await apiServer({ text: "hi" });
    await expect(
      transcribe(wav, { type: "api", endpoint: server.url, model: "m", format: "openrouter" }),
    ).resolves.toBe("hi");
    expect(JSON.parse(server.requests[0]?.body.toString() ?? "")).toEqual({
      model: "m",
      input_audio: { data: Buffer.alloc(100).toString("base64"), format: "wav" },
    });
  });

  it("sends the bearer token when configured", async () => {
    vi.stubEnv("VOICE_STT_API_KEY", "secret");
    const { wav } = await fixture();
    const server = await apiServer({ text: "hi" });
    await transcribe(wav, {
      type: "api",
      endpoint: server.url,
      model: "m",
      apiKeyEnv: "VOICE_STT_API_KEY",
    });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("throws before sending when the api key env var is missing", async () => {
    const { wav } = await fixture();
    const server = await apiServer({ text: "hi" });
    const profile = {
      type: "api",
      endpoint: server.url,
      model: "m",
      apiKeyEnv: "UNSET_KEY",
    } as const;
    await expect(transcribe(wav, profile)).rejects.toThrow(
      "Set UNSET_KEY to use the transcription API",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("throws on HTTP errors", async () => {
    const { wav } = await fixture();
    const server = await apiServer({}, 500);
    await expect(
      transcribe(wav, { type: "api", endpoint: server.url, model: "m" }),
    ).rejects.toThrow("Transcription API returned HTTP 500");
  });

  it("throws on empty text", async () => {
    const { wav } = await fixture();
    const server = await apiServer({ text: "  " });
    await expect(
      transcribe(wav, { type: "api", endpoint: server.url, model: "m" }),
    ).rejects.toThrow("No speech detected");
  });
});
