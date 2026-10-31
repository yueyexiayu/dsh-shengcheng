import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { MAX_REF_BYTES, mimeForExt } from "./parse.js";
import { validateMedia } from "./validate-media.js";

/** Read and validate reference image through the Host filesystem service. */
export async function readReferenceImage(path, cwd, signal, validators, fs) {
  signal?.throwIfAborted();
  if (typeof fs?.resolve !== "function" || typeof fs?.stat !== "function" || typeof fs?.readBytes !== "function") throw new Error("当前 DSH 文件服务不支持受策略保护的参考图读取");
  const resolved = isAbsolute(path) ? path : join(cwd || join(homedir(), "Downloads"), path);
  try {
    const target = await fs.resolve(resolved, { signal });
    const info = await fs.stat(target, signal);
    signal?.throwIfAborted();
    if (!info) throw new Error("参考图不存在");
    if (info.type !== "file") throw new Error("参考图必须是普通文件，不能是目录、设备或管道");
    if (info.size > MAX_REF_BYTES) throw new Error("参考图太大，请换一张不超过 15MB 的图");
    const data = await fs.readBytes(target, signal, MAX_REF_BYTES);
    signal?.throwIfAborted();
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_REF_BYTES) throw new Error("参考图读取返回了无效或超限数据");
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const { ext } = await validateMedia(bytes, "image", signal, validators);
    return { bytes, mimeType: mimeForExt(ext) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === "FS_TOO_LARGE") throw new Error("参考图太大，请换一张不超过 15MB 的图");
    throw error;
  }
}
