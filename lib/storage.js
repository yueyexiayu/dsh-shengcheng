import { mkdir, open, link, unlink, lstat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultFileName } from "./parse.js";

export function sessionCwd(exec) {
  const session = exec?.agent?.session;
  return session?.header?.cwd || session?.requestHeader?.()?.cwd || null;
}

export function sessionProvider(exec) {
  return exec?.agent?.session?.requestHeader?.()?.config?.provider || null;
}

export function resolveOutPath(raw, { cwd, provider, kind, ext }) {
  const base = cwd || join(homedir(), "Downloads");
  if (raw != null && (typeof raw !== "string" || !raw.trim() || /[\x00-\x1f\x7f]/.test(raw))) {
    throw new Error("path 必须是非空且不含控制字符的文件路径");
  }
  if (!raw) return join(base, defaultFileName(provider, kind, ext));
  if (/[\\/]$/.test(raw) || [".", ".."].includes(raw.trim())) throw new Error("path 必须指向文件，不能是目录");
  const target = resolve(base, raw.trim());
  const suffix = extname(target);
  const requested = suffix.slice(1).toLowerCase();
  if (requested === ext || (requested === "jpeg" && ext === "jpg")) return target;
  return `${suffix ? target.slice(0, -suffix.length) : target}.${ext}`;
}

// The installed DSH provider exposes checkedTarget, the same fence used by
// writeText. Binary data cannot go through writeText. Fail closed on providers
// without this capability rather than guessing sandbox containment locally.
async function checkedPath(ctx, exec, path) {
  exec?.signal?.throwIfAborted();
  if (typeof ctx.fs?.resolve !== "function" || typeof ctx.fs?.checkedTarget !== "function"
      || typeof ctx.fs?.processPath !== "function" || typeof ctx.sandboxPolicy?.resolve !== "function") {
    throw new Error("当前 DSH 文件服务不支持受策略保护的二进制保存，已在生成前拒绝操作");
  }
  const policy = ctx.sandboxPolicy.resolve({ session: exec?.agent?.session });
  try {
    const target = await ctx.fs.resolve(path, { signal: exec?.signal });
    const checked = await ctx.fs.checkedTarget(target, policy);
    const local = ctx.fs.processPath(checked);
    if (typeof local !== "string" || !isAbsolute(local) || local.includes("\0")) throw new Error("DSH 未提供有效本地文件路径");
    exec?.signal?.throwIfAborted();
    return resolve(local);
  } catch (error) {
    exec?.signal?.throwIfAborted();
    if (error?.code === "FS_SANDBOX_DENIED") {
      const denied = new Error(`[sandbox: file access denied under ${policy.mode} mode] shengcheng 无权写入目标路径`);
      denied.code = error.code;
      throw denied;
    }
    throw error;
  }
}

export async function referencePath(ctx, exec, raw, cwd) {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new Error("image_path 必须是有效文件路径");
  exec?.signal?.throwIfAborted();
  try {
    const target = await ctx.fs.resolve(raw, { cwd: cwd || join(homedir(), "Downloads"), signal: exec?.signal });
    exec?.signal?.throwIfAborted();
    const path = ctx.fs.processPath(target);
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("参考图必须位于本地文件系统");
    return path;
  } catch (error) {
    exec?.signal?.throwIfAborted();
    throw error;
  }
}

export async function prepareOutput(ctx, exec, raw, options) {
  const requested = resolveOutPath(raw, options);
  // Check every possible resulting extension before the generation request.
  const extensions = options.kind === "video" ? ["mp4"] : ["png", "jpg", "webp", "gif"];
  const candidates = new Map();
  for (const ext of extensions) {
    const candidate = resolveOutPath(requested, { ...options, ext });
    candidates.set(ext, await checkedPath(ctx, exec, candidate));
  }
  const directory = dirname(candidates.get(options.ext));
  if ([...candidates.values()].some(path => dirname(path) !== directory)) throw new Error("输出路径经符号链接解析后目录不一致，请使用明确的输出文件路径");
  await checkedPath(ctx, exec, directory);
  await mkdir(directory, { recursive: true });
  const stage = await checkedPath(ctx, exec, join(directory, `.shengcheng-${randomUUID()}.part`));
  const handle = await open(stage, "wx", 0o600);
  const identity = await handle.stat();
  let closed = false;
  let complete = false;
  let retained = false;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  const ownsFile = async path => {
    const now = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    return Boolean(now?.isFile() && now.dev === identity.dev && now.ino === identity.ino);
  };
  const assertStage = async () => {
    if (!await ownsFile(stage)) throw new Error("媒体暂存文件已被移动或替换，拒绝发布未经验证的数据");
  };
  const removeStage = async () => {
    // Only unlink the exact regular file this operation created. Never delete a
    // replaced path or a symlink after a directory swap.
    if (await ownsFile(stage)) await unlink(stage);
  };
  return {
    async validationDirectory() {
      if (await checkedPath(ctx, exec, directory) !== directory) throw new Error("输出目录在生成期间发生变化");
      return directory;
    },
    async save(bytes, ext) {
      try {
        if (!Buffer.isBuffer(bytes) || !bytes.length || !candidates.has(ext)) throw new Error("没有可保存的有效媒体");
        if (await checkedPath(ctx, exec, stage) !== stage) throw new Error("输出目录在生成期间发生变化");
        await assertStage();
        for (let offset = 0; offset < bytes.length;) {
          exec?.signal?.throwIfAborted();
          const { bytesWritten } = await handle.write(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
          if (!bytesWritten) throw new Error("媒体写入未取得进展");
          offset += bytesWritten;
        }
        await handle.sync();
        complete = true;
        await close();
        const path = candidates.get(ext);
        const suffix = extname(path);
        const stem = path.slice(0, -suffix.length);
        for (let i = 1; i <= 1000; i++) {
          const dest = i === 1 ? path : `${stem}-${i}${suffix}`;
          if (await checkedPath(ctx, exec, stage) !== stage || await checkedPath(ctx, exec, dest) !== dest) {
            throw new Error("输出目录在生成期间发生变化");
          }
          await assertStage();
          try {
            // Hard link publishes a fully written file atomically without overwrite.
            await link(stage, dest);
          } catch (error) {
            if (error.code === "EEXIST") continue;
            throw error;
          }
          if (!await ownsFile(dest)) throw new Error("目标文件在发布期间被替换，不能确认保存成功");
          await removeStage();
          return dest;
        }
        throw new Error("同名文件过多，请选择其他输出文件名");
      } catch (error) {
        if (complete && await ownsFile(stage)) {
          retained = true;
          const failure = new Error(`媒体已生成，但保存/发布未完成；完整数据保留于 ${JSON.stringify(stage)}（实际格式 ${ext}），无需重新生成。原因：${error.message}`);
          failure.name = error.name;
          failure.code = error.code;
          failure.recoveryPath = stage;
          throw failure;
        }
        throw error;
      }
    },
    async dispose() {
      await close();
      if (!retained) await removeStage();
    },
  };
}
