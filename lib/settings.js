import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GROK_ASPECTS, GROK_IMAGE_QUALITIES, GROK_VIDEO_RESOLUTIONS, GPT_QUALITIES, GROK_IMAGE_MODEL, GPT_IMAGE_MODEL, GROK_VIDEO_MODEL, validateModelId } from "./parse.js";

export const DEFAULT_SETTINGS = Object.freeze({ provider: "auto", imageAspectRatio: "auto", imageQuality: "auto", videoResolution: "720p", videoDuration: 5, outputDirectory: "", grokImageModel: GROK_IMAGE_MODEL, gptImageModel: GPT_IMAGE_MODEL, grokVideoModel: GROK_VIDEO_MODEL });
export function settingsPath(home = process.env.DSH_HOME) {
  return join(typeof home === "string" && home.trim() ? home.trim() : join(homedir(), ".dsh"), "storages", "shengcheng", "settings.json");
}
export function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("设置必须是对象");
  const keys = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw new Error("设置字段不完整或包含未知字段");
  if (!["auto", "grok", "gpt"].includes(input.provider)) throw new Error("默认图片提供方无效");
  if (!GROK_ASPECTS.has(input.imageAspectRatio)) throw new Error("默认图片比例无效");
  if (!GPT_QUALITIES.has(input.imageQuality)) throw new Error("默认图片质量无效");
  if (input.provider !== "grok" && !["auto", "1:1", "3:2", "2:3"].includes(input.imageAspectRatio)) throw new Error("该图片比例不适用于 GPT 或自动提供方");
  if (input.provider !== "gpt" && !GROK_IMAGE_QUALITIES.has(input.imageQuality)) throw new Error("该图片质量不适用于 Grok 或自动提供方");
  if (!GROK_VIDEO_RESOLUTIONS.has(input.videoResolution)) throw new Error("默认视频分辨率无效");
  if (!Number.isInteger(input.videoDuration) || input.videoDuration < 1 || input.videoDuration > 15) throw new Error("默认视频时长必须为 1–15 秒");
  if (typeof input.outputDirectory !== "string" || input.outputDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(input.outputDirectory)) throw new Error("默认保存目录无效");
  for (const key of ["grokImageModel", "gptImageModel", "grokVideoModel"]) validateModelId(input[key]);
  return { ...input, outputDirectory: input.outputDirectory.trim() };
}
export async function loadSettings(path = settingsPath()) {
  let body;
  try { body = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS }; throw error; }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return validateSettings(parsed);
  const migrated = { ...parsed };
  for (const key of ["grokImageModel", "gptImageModel", "grokVideoModel"]) {
    if (!Object.hasOwn(migrated, key)) migrated[key] = DEFAULT_SETTINGS[key];
  }
  return validateSettings(migrated);
}
export async function saveSettings(input, path = settingsPath()) {
  const settings = validateSettings(input);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.settings-${randomUUID()}.tmp`);
  let file;
  let owned = false;
  try {
    file = await open(temporary, "wx", 0o600);
    owned = true;
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await file.close();
    file = undefined;
    await rename(temporary, path);
    owned = false;
    return settings;
  } finally {
    if (file) await file.close().catch(() => {});
    if (owned) await unlink(temporary).catch(() => {});
  }
}

export function settingsHandler(path = settingsPath()) {
  let writes = Promise.resolve();
  const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  return async request => {
    try {
      if (request.method === "GET") {
        await writes;
        return response(200, { ok: true, settings: await loadSettings(path) });
      }
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > 16384) return response(413, { ok: false, error: "设置内容过大" });
      let body;
      try { body = JSON.parse(text); } catch { return response(400, { ok: false, error: "请求体不是有效 JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "settings")) return response(400, { ok: false, error: "无效的设置请求" });
      try { validateSettings(body.settings); } catch (error) { return response(400, { ok: false, error: error.message }); }
      const operation = writes.then(async () => {
        await loadSettings(path); // Do not overwrite an unreadable or corrupted existing file.
        return saveSettings(body.settings, path);
      });
      writes = operation.catch(() => {});
      return response(200, { ok: true, settings: await operation });
    } catch (error) { return response(500, { ok: false, error: `设置读取或保存失败：${error.message}` }); }
  };
}
