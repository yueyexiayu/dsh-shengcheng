import { mkdir, writeFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  GPT_IMAGE_MODEL,
  GPT_IMAGE_URL,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_URL,
  GROK_VIDEO_GET_URL,
  GROK_VIDEO_MODEL,
  GROK_VIDEO_URL,
  IMAGE_TIMEOUT_MS,
  MAX_REF_BYTES,
  VIDEO_POLL_MS,
  VIDEO_TIMEOUT_MS,
  defaultFileName,
  extForImageBytes,
  gptQuality,
  gptSize,
  grokAspect,
  grokImageQuality,
  grokImageResolution,
  grokVideoResolution,
  imagePayloadFromBody,
  mimeForExt,
  mediaUrl,
  videoDuration,
  videoPollState,
  videoRequestId,
} from "./parse.js";
import { authorizedJson, gptHeaders, grokHeaders, requestJson } from "./oauth.js";

export function sessionCwd(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session;
    if (!session) return null;
    if (session.header && typeof session.header.cwd === "string" && session.header.cwd) {
      return session.header.cwd;
    }
    if (typeof session.requestHeader === "function") {
      const header = session.requestHeader();
      if (header && typeof header.cwd === "string" && header.cwd) return header.cwd;
    }
  } catch {
    // optional
  }
  return null;
}

export function sessionProvider(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session;
    const header = session && typeof session.requestHeader === "function" ? session.requestHeader() : null;
    const cfg = header && header.config;
    if (cfg && typeof cfg.provider === "string") return cfg.provider;
  } catch {
    // optional
  }
  return null;
}

function downloadsDir() {
  return join(homedir(), "Downloads");
}

export function resolveOutPath(raw, { cwd, provider, kind, ext }) {
  const base = cwd || downloadsDir();
  if (raw != null && String(raw).trim()) {
    const value = String(raw).trim();
    const resolved = isAbsolute(value) ? value : join(base, value);
    const suffix = extname(resolved);
    const requestedExt = suffix.slice(1).toLowerCase();
    if (requestedExt === ext || (requestedExt === "jpeg" && ext === "jpg")) return resolved;
    return `${suffix ? resolved.slice(0, -suffix.length) : resolved}.${ext}`;
  }
  return join(base, defaultFileName(provider, kind, ext));
}

export async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 1; ; i++) {
    const dest = i === 1 ? path : `${stem}-${i}${ext}`;
    try {
      await writeFile(dest, bytes, { flag: "wx" });
      return dest;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function combinedSignal(timeoutMs, signal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function downloadBytes(rawUrl, signal) {
  let url = mediaUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    // Generated media uses public/signed download URLs, never account tokens.
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("生成文件重定向缺少下载地址");
      url = mediaUrl(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`下载生成文件失败 (HTTP ${response.status})`);
    const type = response.headers.get("content-type") || "";
    if (/^(text\/|application\/(?:json|xml|xhtml))/i.test(type)) {
      await response.body?.cancel();
      throw new Error("生成文件下载响应不是图片或视频");
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("生成文件下载重定向过多");
}

async function payloadBytes(payload, signal, kind = "image") {
  const bytes = payload.kind === "b64" ? payload.bytes : await downloadBytes(payload.url, signal);
  if (kind === "image" ? !extForImageBytes(bytes) : bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error(kind === "image" ? "生成结果不是有效图片" : "生成结果不是有效 MP4 视频");
  }
  return bytes;
}

export async function generateImage(ctx, { provider, prompt, aspectRatio, resolution, quality, size, signal }) {
  signal = combinedSignal(IMAGE_TIMEOUT_MS, signal);
  signal.throwIfAborted();
  if (provider === "grok") {
    const json = {
      model: GROK_IMAGE_MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
    };
    const aspect = grokAspect(aspectRatio);
    const res = grokImageResolution(resolution);
    const q = grokImageQuality(quality);
    if (aspect) json.aspect_ratio = aspect;
    if (res) json.resolution = res;
    if (q) json.quality = q;
    const hit = await authorizedJson(ctx, "grok", (grant) => {
      return requestJson(GROK_IMAGE_URL, {
        method: "POST",
        headers: grokHeaders(grant),
        json,
        signal,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }, signal);
    const bytes = await payloadBytes(imagePayloadFromBody(hit.body), signal);
    return { bytes, model: GROK_IMAGE_MODEL };
  }

  const json = {
    model: GPT_IMAGE_MODEL,
    prompt,
    n: 1,
    quality: gptQuality(quality),
    size: gptSize(aspectRatio, size),
  };
  const hit = await authorizedJson(ctx, "gpt", (grant) => requestJson(GPT_IMAGE_URL, {
    method: "POST",
    headers: gptHeaders(grant),
    json,
    signal,
    timeoutMs: IMAGE_TIMEOUT_MS,
  }), signal);
  const payload = imagePayloadFromBody(hit.body);
  const bytes = await payloadBytes(payload, signal);
  return { bytes, model: GPT_IMAGE_MODEL };
}

export async function readReferenceImage(path, cwd) {
  const resolved = isAbsolute(path) ? path : join(cwd || downloadsDir(), path);
  const bytes = await readFile(resolved);
  if (bytes.length > MAX_REF_BYTES) throw new Error("参考图太大，请换一张不超过 15MB 的图");
  const ext = extForImageBytes(bytes);
  if (!ext) throw new Error("参考图不是有效图片");
  return { url: `data:${mimeForExt(ext)};base64,${bytes.toString("base64")}`, path: resolved };
}

export async function generateVideo(ctx, {
  prompt,
  aspectRatio,
  resolution,
  duration,
  imagePath,
  cwd,
  signal,
}) {
  signal = combinedSignal(VIDEO_TIMEOUT_MS, signal);
  signal.throwIfAborted();
  const json = {
    model: GROK_VIDEO_MODEL,
    prompt,
    duration: videoDuration(duration),
    resolution: grokVideoResolution(resolution),
  };
  const aspect = grokAspect(aspectRatio, { video: true });
  if (aspect) json.aspect_ratio = aspect;
  if (imagePath) {
    const ref = await readReferenceImage(String(imagePath).trim(), cwd);
    json.image = { url: ref.url };
  }

  const started = await authorizedJson(ctx, "grok", (grant) => {
    return requestJson(GROK_VIDEO_URL, {
      method: "POST",
      headers: grokHeaders(grant),
      json,
      signal,
      timeoutMs: 60_000,
    });
  }, signal);
  const requestId = videoRequestId(started.body);
  while (true) {
    await sleep(VIDEO_POLL_MS, undefined, { signal });
    const poll = await authorizedJson(ctx, "grok", (grant) => {
      return requestJson(`${GROK_VIDEO_GET_URL}/${requestId}`, {
        headers: grokHeaders(grant),
        signal,
        timeoutMs: 30_000,
      });
    }, signal);
    const state = videoPollState(poll.status, poll.body);
    if (state.state === "done") {
      const bytes = await payloadBytes({ kind: "url", url: state.url }, signal, "video");
      return { bytes, model: GROK_VIDEO_MODEL, duration: state.duration, requestId };
    }
  }
}
