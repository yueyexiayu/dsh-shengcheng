import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  GPT_IMAGE_MODEL, GPT_IMAGE_URL, GROK_IMAGE_MODEL, GROK_IMAGE_URL,
  GROK_VIDEO_GET_URL, GROK_VIDEO_MODEL, GROK_VIDEO_URL,
  IMAGE_TIMEOUT_MS, MAX_REF_BYTES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES,
  VIDEO_POLL_MS, VIDEO_TIMEOUT_MS, gptQuality, gptSize, grokAspect,
  grokImageQuality, grokImageResolution, grokVideoResolution, imagePayloadFromBody,
  mimeForExt, videoDuration, videoPollState, videoRequestId,
} from "./parse.js";
import { authorizedJson, gptHeaders, grokHeaders, requestJson } from "./oauth.js";
import { downloadBytes } from "./network.js";
import { preflightMediaValidation, validateMedia } from "./validate-media.js";

function combinedSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function payloadBytes(payload, signal, kind, validators) {
  signal.throwIfAborted();
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const bytes = payload.kind === "b64" ? payload.bytes : await downloadBytes(payload.url, signal, limit);
  await validateMedia(bytes, kind, signal, validators);
  return bytes;
}

export async function generateImage(ctx, { provider, prompt, aspectRatio, resolution, quality, size, signal, validationDirectory }) {
  signal = combinedSignal(IMAGE_TIMEOUT_MS, signal);
  signal.throwIfAborted();
  const validators = await preflightMediaValidation(signal);
  validators.validationDirectory = validationDirectory;
  if (provider === "grok") {
    const json = { model: GROK_IMAGE_MODEL, prompt, n: 1, response_format: "b64_json" };
    const aspect = grokAspect(aspectRatio);
    const res = grokImageResolution(resolution);
    const q = grokImageQuality(quality);
    if (aspect) json.aspect_ratio = aspect;
    if (res) json.resolution = res;
    if (q) json.quality = q;
    const hit = await authorizedJson(ctx, "grok", grant => requestJson(GROK_IMAGE_URL, {
      method: "POST", headers: grokHeaders(grant), json, signal, timeoutMs: IMAGE_TIMEOUT_MS,
    }), signal);
    const bytes = await payloadBytes(imagePayloadFromBody(hit.body), signal, "image", validators);
    return { bytes, model: GROK_IMAGE_MODEL };
  }
  const json = { model: GPT_IMAGE_MODEL, prompt, n: 1, quality: gptQuality(quality), size: gptSize(aspectRatio, size) };
  const hit = await authorizedJson(ctx, "gpt", grant => requestJson(GPT_IMAGE_URL, {
    method: "POST", headers: gptHeaders(grant), json, signal, timeoutMs: IMAGE_TIMEOUT_MS,
  }), signal);
  const bytes = await payloadBytes(imagePayloadFromBody(hit.body), signal, "image", validators);
  return { bytes, model: GPT_IMAGE_MODEL };
}

export async function readReferenceImage(path, cwd, signal, validators) {
  signal?.throwIfAborted();
  const resolved = isAbsolute(path) ? path : join(cwd || join(homedir(), "Downloads"), path);
  // O_NONBLOCK prevents opening a FIFO from waiting for a writer. fstat applies to
  // the opened descriptor, so a pathname swap cannot bypass the regular-file test.
  const file = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
  let stream;
  let bytes;
  try {
    signal?.throwIfAborted();
    const info = await file.stat();
    if (!info.isFile()) throw new Error("参考图必须是普通文件，不能是目录、设备或管道");
    if (info.size > MAX_REF_BYTES) throw new Error("参考图太大，请换一张不超过 15MB 的图");
    signal?.throwIfAborted();
    stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal });
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      length += chunk.length;
      if (length > MAX_REF_BYTES) throw new Error("参考图太大，请换一张不超过 15MB 的图");
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    bytes = Buffer.concat(chunks, length);
  } finally {
    stream?.destroy();
    await file.close();
  }
  const { ext } = await validateMedia(bytes, "image", signal, validators);
  signal?.throwIfAborted();
  return { url: `data:${mimeForExt(ext)};base64,${bytes.toString("base64")}`, path: resolved };
}

export async function generateVideo(ctx, { prompt, aspectRatio, resolution, duration, imagePath, cwd, signal, validationDirectory }) {
  signal = combinedSignal(VIDEO_TIMEOUT_MS, signal);
  signal.throwIfAborted();
  const validators = await preflightMediaValidation(signal);
  validators.validationDirectory = validationDirectory;
  const json = { model: GROK_VIDEO_MODEL, prompt, duration: videoDuration(duration), resolution: grokVideoResolution(resolution) };
  const aspect = grokAspect(aspectRatio, { video: true });
  if (aspect) json.aspect_ratio = aspect;
  if (imagePath) {
    const ref = await readReferenceImage(String(imagePath).trim(), cwd, signal, validators);
    json.image = { url: ref.url };
  }
  const started = await authorizedJson(ctx, "grok", grant => requestJson(GROK_VIDEO_URL, {
    method: "POST", headers: grokHeaders(grant), json, signal, timeoutMs: 60_000,
  }), signal);
  const requestId = videoRequestId(started.body);
  while (true) {
    await sleep(VIDEO_POLL_MS, undefined, { signal });
    const poll = await authorizedJson(ctx, "grok", grant => requestJson(`${GROK_VIDEO_GET_URL}/${encodeURIComponent(requestId)}`, {
      headers: grokHeaders(grant), signal, timeoutMs: 30_000,
    }), signal);
    const state = videoPollState(poll.status, poll.body);
    if (state.state === "done") {
      const bytes = await payloadBytes({ kind: "url", url: state.url }, signal, "video", validators);
      return { bytes, model: GROK_VIDEO_MODEL, duration: state.duration, requestId };
    }
  }
}
