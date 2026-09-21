import { mkdir, writeFile, readFile, access } from "node:fs/promises";
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
    return isAbsolute(value) ? value : join(base, value);
  }
  return join(base, defaultFileName(provider, kind, ext));
}

export async function uniquePath(path) {
  try {
    await access(path);
  } catch {
    return path;
  }
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 2; i < 50; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

export async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const dest = await uniquePath(path);
  await writeFile(dest, bytes);
  return dest;
}

function combinedSignal(timeoutMs, signal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function downloadBytes(url, headers, signal) {
  const response = await fetch(url, {
    headers: headers || {},
    signal: combinedSignal(IMAGE_TIMEOUT_MS, signal),
  });
  if (!response.ok) throw new Error(`下载生成文件失败 (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function payloadBytes(payload, grant, signal) {
  if (payload.kind === "b64") return payload.bytes;
  try {
    return await downloadBytes(payload.url, grokHeaders(grant), signal);
  } catch {
    return downloadBytes(payload.url, {}, signal);
  }
}

export async function generateImage(ctx, { provider, prompt, aspectRatio, resolution, quality, size, signal }) {
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
    let usedGrant;
    const hit = await authorizedJson(ctx, "grok", (grant) => {
      usedGrant = grant;
      return requestJson(GROK_IMAGE_URL, {
        method: "POST",
        headers: grokHeaders(grant),
        json,
        signal,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
    });
    const bytes = await payloadBytes(imagePayloadFromBody(hit.body), usedGrant, signal);
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
  }));
  const payload = imagePayloadFromBody(hit.body);
  const bytes = payload.kind === "b64" ? payload.bytes : await downloadBytes(payload.url, {}, signal);
  return { bytes, model: GPT_IMAGE_MODEL };
}

export async function readReferenceImage(path, cwd) {
  const resolved = isAbsolute(path) ? path : join(cwd || downloadsDir(), path);
  const bytes = await readFile(resolved);
  if (bytes.length > MAX_REF_BYTES) throw new Error("参考图太大，请换一张不超过 15MB 的图");
  const ext = extForImageBytes(bytes) || extname(resolved).slice(1).toLowerCase() || "png";
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

  let usedGrant;
  const started = await authorizedJson(ctx, "grok", (grant) => {
    usedGrant = grant;
    return requestJson(GROK_VIDEO_URL, {
      method: "POST",
      headers: grokHeaders(grant),
      json,
      signal,
      timeoutMs: 60_000,
    });
  });
  const requestId = videoRequestId(started.body);
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error("视频生成已取消");
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
    const poll = await authorizedJson(ctx, "grok", (grant) => {
      usedGrant = grant;
      return requestJson(`${GROK_VIDEO_GET_URL}/${requestId}`, {
        headers: grokHeaders(grant),
        signal,
        timeoutMs: 30_000,
      });
    });
    const state = videoPollState(poll.status, poll.body);
    if (state.state === "done") {
      const bytes = await payloadBytes({ kind: "url", url: state.url }, usedGrant, signal);
      return { bytes, model: GROK_VIDEO_MODEL, duration: state.duration, requestId };
    }
  }
  throw new Error("Grok 视频生成超时，请稍后重试或把 duration/resolution 调低");
}
