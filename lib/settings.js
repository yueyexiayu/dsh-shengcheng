import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SETTINGS = Object.freeze({ imageRoute: null, videoRoute: null, imageFallbackRoute: null, videoFallbackRoute: null, imageAspectRatio: "auto", imageQuality: "auto", videoResolution: "720p", videoDuration: 5, outputDirectory: "", legacySettings: null });
export function settingsPath(home = process.env.DSH_HOME) {
  return join(typeof home === "string" && home.trim() ? home.trim() : join(homedir(), ".dsh"), "storages", "shengcheng", "settings.json");
}
export function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("设置必须是对象");
  const keys = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw new Error("设置字段不完整或包含未知字段");
  for (const key of ["imageRoute", "videoRoute", "imageFallbackRoute", "videoFallbackRoute"]) {
    const route = input[key];
    if (route !== null && (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).length !== 2 || typeof route.provider !== "string" || !route.provider || route.provider.length > 256 || /[\x00-\x1f\x7f]/.test(route.provider) || typeof route.model !== "string" || !route.model || route.model.length > 512 || /[\x00-\x1f\x7f]/.test(route.model))) throw new Error("模型路线须包含有效提供方和模型 ID");
  }
  for (const key of ["imageAspectRatio", "imageQuality", "videoResolution"]) if (typeof input[key] !== "string" || !input[key] || input[key].length > 128 || /[\x00-\x1f\x7f]/.test(input[key])) throw new Error("默认媒体参数无效");
  if (input.videoDuration !== null && (!Number.isInteger(input.videoDuration) || input.videoDuration < 1 || input.videoDuration > 3600)) throw new Error("默认视频时长必须为 1–3600 秒或留空");
  if (typeof input.outputDirectory !== "string" || input.outputDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(input.outputDirectory)) throw new Error("默认保存目录无效");
  if (input.legacySettings !== null && (!input.legacySettings || typeof input.legacySettings !== "object" || Array.isArray(input.legacySettings) || Buffer.byteLength(JSON.stringify(input.legacySettings), "utf8") > 8192)) throw new Error("旧设置快照无效");
  return { ...input, outputDirectory: input.outputDirectory.trim() };
}
export async function loadSettings(path = settingsPath()) {
  return (await readSettings(path)).settings;
}
async function readSettings(path) {
  let body;
  try { body = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { settings: { ...DEFAULT_SETTINGS }, revision: "absent" }; throw error; }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("设置必须是对象");
  if (!Object.hasOwn(parsed, "imageRoute")) {
    const required = ["provider", "imageAspectRatio", "imageQuality", "videoResolution", "videoDuration", "outputDirectory"];
    const optional = ["grokImageModel", "gptImageModel", "grokVideoModel"];
    if (required.some(key => !Object.hasOwn(parsed, key)) || Object.keys(parsed).some(key => !required.includes(key) && !optional.includes(key)) || !["auto", "grok", "gpt"].includes(parsed.provider) || optional.some(key => Object.hasOwn(parsed, key) && (typeof parsed[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(parsed[key])))) throw new Error("旧设置字段不完整或无效，已保留原文件");
    const ratios = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2"];
    if (!ratios.includes(parsed.imageAspectRatio) || !["auto", "low", "medium", "high"].includes(parsed.imageQuality) || !["480p", "720p", "1080p"].includes(parsed.videoResolution) || !Number.isInteger(parsed.videoDuration) || parsed.videoDuration < 1 || parsed.videoDuration > 15 || (parsed.provider !== "grok" && !["auto", "1:1", "3:2", "2:3"].includes(parsed.imageAspectRatio)) || (parsed.provider !== "gpt" && parsed.imageQuality === "high")) throw new Error("旧设置参数无效，已保留原文件");
  }
  const migrated = Object.hasOwn(parsed, "imageRoute") ? { imageFallbackRoute: null, videoFallbackRoute: null, ...parsed } : {
    imageRoute: null, videoRoute: null, imageFallbackRoute: null, videoFallbackRoute: null,
    imageAspectRatio: parsed.imageAspectRatio, imageQuality: parsed.imageQuality,
    videoResolution: parsed.videoResolution, videoDuration: parsed.videoDuration,
    outputDirectory: parsed.outputDirectory, legacySettings: parsed,
  };
  return { settings: validateSettings(migrated), revision: createHash("sha256").update(body).digest("hex") };
}
async function saveSettings(input, path = settingsPath()) {
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
        return response(200, { ok: true, ...await readSettings(path) });
      }
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > 16384) return response(413, { ok: false, error: "设置内容过大" });
      let body;
      try { body = JSON.parse(text); } catch { return response(400, { ok: false, error: "请求体不是有效 JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, "settings") || typeof body.revision !== "string") return response(400, { ok: false, error: "无效的设置请求，请刷新页面" });
      try { validateSettings(body.settings); } catch (error) { return response(400, { ok: false, error: error.message }); }
      const operation = writes.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const db = new DatabaseSync(`${path}.lock.sqlite`);
        try {
          try { db.exec("BEGIN IMMEDIATE"); } catch (error) { if (error.errcode === 5 || error.errcode === 6) return null; throw error; }
          const current = await readSettings(path);
          if (current.revision !== body.revision) return null;
          if (JSON.stringify(current.settings.legacySettings) !== JSON.stringify(body.settings.legacySettings)) throw new Error("旧设置快照不能通过设置页面修改");
          await saveSettings(body.settings, path);
          return await readSettings(path);
        } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
      });
      writes = operation.catch(() => {});
      const saved = await operation;
      return saved ? response(200, { ok: true, ...saved }) : response(409, { ok: false, error: "设置已被其他窗口或 Host 修改，请重新加载后再保存" });
    } catch (error) { return response(500, { ok: false, error: `设置读取或保存失败：${error.message}` }); }
  };
}
