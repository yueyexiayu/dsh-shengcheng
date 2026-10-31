/** Common media limits, safe paths and presentation; no provider credentials. */
export const PLUGIN_ID = "shengcheng";
export const MEDIA_TIMEOUT_MS = 600_000;
export const MAX_REF_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

export function resolveKind(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key || key === "image" || key === "img") return "image";
  if (key === "video") return "video";
  throw new Error("kind 只能是 image 或 video");
}
export function defaultFileName(provider, kind, ext, date = new Date()) {
  const p = n => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `shengcheng-${provider}-${kind}-${stamp}.${ext}`;
}
export function extForImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  return null;
}
export function mimeForExt(ext) {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}
export function mediaUrl(raw, base) {
  let url;
  try { url = new URL(raw, base); } catch { throw new Error("生成文件下载地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("生成文件必须使用无登录信息的 HTTPS 下载地址");
  return url.href;
}
export function renderSaved(path, extra) {
  const lines = [`saved ${path}`];
  if (extra) lines.push(extra);
  lines.push(`shengcheng_result ${JSON.stringify({ path })}`);
  return [{ type: "text", text: lines.join("\n") }];
}
