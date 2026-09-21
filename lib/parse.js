/** Routing, path names, and response parsing for shengcheng. No credentials. */

export const PLUGIN_ID = "shengcheng";
export const GROK_RECORD_KEY = "llm-pi-ai/xai";
export const GPT_RECORD_KEY = "llm-pi-ai/openai-codex";

export const GROK_IMAGE_MODEL = "grok-imagine-image-2.0";
export const GROK_VIDEO_MODEL = "grok-imagine-video-1.5";
export const GPT_IMAGE_MODEL = "gpt-image-2";

export const GROK_IMAGE_URL = "https://api.x.ai/v1/images/generations";
export const GROK_VIDEO_URL = "https://api.x.ai/v1/videos/generations";
export const GROK_VIDEO_GET_URL = "https://api.x.ai/v1/videos";
export const GPT_IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

export const IMAGE_TIMEOUT_MS = 180_000;
export const VIDEO_TIMEOUT_MS = 720_000;
export const VIDEO_POLL_MS = 5_000;
export const FETCH_MS = 30_000;
export const MAX_REF_BYTES = 15 * 1024 * 1024;

export const GROK_ASPECTS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2", "auto",
]);
export const GROK_VIDEO_ASPECTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
export const GROK_IMAGE_RESOLUTIONS = new Set(["1k", "2k"]);
export const GROK_VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
export const GROK_IMAGE_QUALITIES = new Set(["low", "medium", "auto"]);
export const GPT_QUALITIES = new Set(["low", "medium", "high", "auto"]);

const GPT_SIZE_BY_ASPECT = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

export function normalizeProvider(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key || key === "auto") return "auto";
  if (key === "grok" || key === "xai") return "grok";
  if (key === "gpt" || key === "chatgpt" || key === "codex" || key === "openai-codex" || key === "openai") return "gpt";
  return null;
}

export function providerFromSession(raw) {
  if (raw === "xai") return "grok";
  if (raw === "openai-codex") return "gpt";
  return null;
}

export function resolveImageProvider({ requested, current, grokOk, gptOk }) {
  const want = normalizeProvider(requested);
  if (requested && want === null) throw new Error("provider 只能是 grok、gpt 或 auto");
  if (want === "grok") {
    if (!grokOk) throw new Error("未登录 Grok，请先用输入框下方的 OAuth 登录");
    return "grok";
  }
  if (want === "gpt") {
    if (!gptOk) throw new Error("未登录 GPT，请先用输入框下方的 OAuth 登录");
    return "gpt";
  }
  const fromSession = providerFromSession(current);
  if (fromSession === "grok" && grokOk) return "grok";
  if (fromSession === "gpt" && gptOk) return "gpt";
  if (grokOk) return "grok";
  if (gptOk) return "gpt";
  throw new Error("未登录 Grok 或 GPT，请先用输入框下方的 OAuth 登录");
}

export function resolveKind(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key || key === "image" || key === "img") return "image";
  if (key === "video") return "video";
  throw new Error("kind 只能是 image 或 video");
}

export function resolveVideoProvider({ requested, grokOk }) {
  const want = normalizeProvider(requested);
  if (requested && want === null) throw new Error("provider 只能是 grok 或 auto");
  if (want === "gpt") throw new Error("GPT 账号不能生成视频，请用 Grok，或把 kind 改成 image");
  if (!grokOk) throw new Error("生成视频只用 Grok 账号，请先用输入框下方的 OAuth 登录 Grok");
  return "grok";
}

export function grokAspect(raw, { video = false } = {}) {
  if (raw == null || raw === "") return null;
  const value = String(raw).trim();
  const allowed = video ? GROK_VIDEO_ASPECTS : GROK_ASPECTS;
  if (!allowed.has(value)) throw new Error(`不支持的 aspect_ratio: ${value}`);
  return value === "auto" ? null : value;
}

export function grokImageResolution(raw) {
  if (raw == null || raw === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (!GROK_IMAGE_RESOLUTIONS.has(value)) throw new Error("resolution 只能是 1k 或 2k");
  return value;
}

export function grokVideoResolution(raw) {
  if (raw == null || raw === "") return "720p";
  const value = String(raw).trim().toLowerCase();
  if (!GROK_VIDEO_RESOLUTIONS.has(value)) throw new Error("resolution 只能是 480p、720p 或 1080p");
  return value;
}

export function grokImageQuality(raw) {
  if (raw == null || raw === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (!GROK_IMAGE_QUALITIES.has(value)) throw new Error("Grok quality 只能是 low、medium 或 auto");
  return value;
}

export function gptQuality(raw) {
  if (raw == null || raw === "") return "low";
  const value = String(raw).trim().toLowerCase();
  if (!GPT_QUALITIES.has(value)) throw new Error("GPT quality 只能是 low、medium、high 或 auto");
  return value;
}

export function gptSize(aspectRatio, size) {
  if (size != null && String(size).trim()) {
    const value = String(size).trim();
    if (!/^\d{3,4}x\d{3,4}$/.test(value)) throw new Error("size 格式应为 1024x1024");
    return value;
  }
  if (aspectRatio == null || aspectRatio === "" || aspectRatio === "auto") return "1024x1024";
  const mapped = GPT_SIZE_BY_ASPECT[String(aspectRatio).trim()];
  return mapped || "1024x1024";
}

export function videoDuration(raw) {
  if (raw == null || raw === "") return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error("duration 必须是 1 到 15 的整数秒");
  return n;
}

export function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function defaultFileName(provider, kind, ext, date) {
  return `shengcheng-${provider}-${kind}-${fileStamp(date)}.${ext}`;
}

export function extForImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return "png";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "webp";
  }
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "mp4";
  return "png";
}

export function mimeForExt(ext) {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  return "image/png";
}

export function httpErrorMessage(status, body) {
  const fromBody = errorFromBody(body);
  if (fromBody) return fromBody;
  if (status === 401 || status === 403) return `凭证无效或已过期 (HTTP ${status})`;
  return `请求失败 (HTTP ${status})`;
}

export function errorFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim().slice(0, 300);
  if (body.error && typeof body.error === "object") {
    const message = body.error.message || body.error.code;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim().slice(0, 300);
  return null;
}

export function imagePayloadFromBody(body) {
  const data = body && Array.isArray(body.data) ? body.data[0] : null;
  if (!data || typeof data !== "object") throw new Error("生图响应里没有图片");
  if (typeof data.b64_json === "string" && data.b64_json) {
    return { kind: "b64", bytes: Buffer.from(data.b64_json, "base64") };
  }
  if (typeof data.url === "string" && data.url.startsWith("http")) {
    return { kind: "url", url: data.url };
  }
  throw new Error("生图响应既没有图片数据也没有下载地址");
}

export function videoRequestId(body) {
  const id = body && typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (!id) throw new Error("Grok 视频任务没有返回 request_id");
  return id;
}

export function videoPollState(status, body) {
  const state = body && typeof body.status === "string" ? body.status : null;
  if (state === "done") {
    const url = body.video && typeof body.video.url === "string" ? body.video.url : null;
    if (!url) throw new Error("Grok 视频已完成但没有下载地址");
    return { state, url, duration: body.video && body.video.duration != null ? body.video.duration : null };
  }
  if (state === "failed" || state === "expired") {
    throw new Error(errorFromBody(body) || `Grok 视频${state === "failed" ? "生成失败" : "任务过期"}`);
  }
  if (status === 202 || state === "pending" || !state) return { state: "pending" };
  return { state: state || "pending" };
}

export function grantFromRecord(record) {
  if (!record || record.kind !== "grant" || !record.payload || typeof record.payload !== "object") {
    return null;
  }
  const payload = record.payload;
  const access = typeof payload.access === "string" && payload.access ? payload.access : null;
  const refresh = typeof payload.refresh === "string" && payload.refresh ? payload.refresh : null;
  if (!access || !refresh) return null;
  const expires = Number(payload.expires);
  const accountId =
    (typeof payload.accountId === "string" && payload.accountId)
    || accountIdFromJwt(access);
  return {
    access,
    refresh,
    accountId: accountId || null,
    expires: Number.isFinite(expires) ? expires : null,
  };
}

export function accountIdFromJwt(access) {
  try {
    const parts = String(access).split(".");
    if (parts.length < 2) return null;
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const auth = json && json["https://api.openai.com/auth"];
    const id = auth && auth.chatgpt_account_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function renderSaved(path, extra) {
  const lines = [`saved ${path}`];
  if (extra) lines.push(extra);
  return [{ type: "text", text: lines.join("\n") }];
}
