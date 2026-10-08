import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extForImageBytes, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "./parse.js";

const MAX_PIXELS = 64 * 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const imageFormats = { png: "png_pipe", jpg: "jpeg_pipe", webp: "webp_pipe", gif: "gif" };

async function executable(name) {
  const filename = process.platform === "win32" ? `${name}.exe` : name;
  const folders = [...(process.env.PATH || "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const folder of [...new Set(folders.filter(Boolean))]) {
    const path = join(folder, filename);
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next install location. */ }
  }
  throw new Error(`媒体验证需要 ${name}，请先安装 FFmpeg（包含 ffmpeg 和 ffprobe）`);
}

export async function preflightMediaValidation(signal) {
  signal?.throwIfAborted();
  const [ffmpeg, ffprobe] = await Promise.all([executable("ffmpeg"), executable("ffprobe")]);
  const timeout = AbortSignal.timeout(5_000);
  const checkSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await Promise.all([run(ffmpeg, ["-v", "error", "-version"], checkSignal), run(ffprobe, ["-v", "error", "-version"], checkSignal)]);
  checkSignal.throwIfAborted();
  return { ffmpeg, ffprobe };
}

function run(binary, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    let stdout = "", stderr = "", length = 0, failure;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stop = () => { failure = signal.reason; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const collect = (target, chunk) => {
      length += chunk.length;
      if (length > MAX_PROCESS_OUTPUT) {
        failure ||= new Error("媒体验证输出超过安全上限");
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    child.once("error", () => { failure ||= new Error("无法启动 FFmpeg 媒体验证程序"); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (failure) reject(failure);
      // -v error output is not a warning. Never silently accept a recoverable decode error.
      else if (code !== 0 || stderr.trim()) reject(new Error("生成结果不是可完整解码的有效媒体"));
      else resolvePromise(stdout);
    });
  });
}

function isCoverStream(stream) {
  const disposition = stream?.disposition || {};
  return ["attached_pic", "timed_thumbnails", "still_image"].some(key => Number(disposition[key]) === 1);
}

export async function validateMedia(bytes, kind, signal, validators) {
  signal?.throwIfAborted();
  const maxBytes = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) throw new Error("媒体数据为空或超过大小上限");
  const ext = kind === "image" ? extForImageBytes(bytes) : null;
  if (kind === "image" ? !ext : bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error(kind === "image" ? "生成结果不是有效图片" : "生成结果不是有效 MP4 视频");
  }
  const timeout = AbortSignal.timeout(VALIDATE_TIMEOUT_MS);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  validators ||= await preflightMediaValidation(signal);
  const root = resolve(validators.validationDirectory ? await validators.validationDirectory() : tmpdir());
  signal.throwIfAborted();
  const dir = await mkdtemp(join(root, "shengcheng-validate-"));
  try {
    const path = join(dir, kind === "image" ? `input.${ext}` : "input.mp4");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600, signal });
    const input = ["-protocol_whitelist", "file,pipe", "-f", kind === "image" ? imageFormats[ext] : "mov"];
    if (kind === "video") input.push("-enable_drefs", "0", "-use_absolute_path", "0");
    const common = ["-v", "error", "-max_alloc", "268435456", "-max_pixels", String(MAX_PIXELS), "-threads", "1"];
    const probe = JSON.parse(await run(validators.ffprobe, [...common, ...input,
      "-show_entries", "stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic,timed_thumbnails,still_image:format=duration,format_name",
      "-of", "json", path], signal));
    // Grok video MP4s ship an MJPEG cover (attached_pic) beside the playable H.264 track.
    // That cover is a second video stream and must not fail the single-track check.
    const streams = Array.isArray(probe.streams) ? probe.streams.filter(stream => stream.codec_type === "video" && !isCoverStream(stream)) : [];
    if (streams.length !== 1) throw new Error("媒体缺少唯一可解码的视频或图像轨道");
    const stream = streams[0];
    if (!Number.isSafeInteger(stream.index) || stream.index < 0) throw new Error("媒体缺少可定位的视频或图像轨道");
    if (!Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)
      || stream.width < 1 || stream.height < 1 || stream.width * stream.height > MAX_PIXELS) {
      throw new Error("媒体尺寸无效或超过 64MP 像素上限");
    }
    if (kind === "video") {
      const duration = Number(probe.format?.duration ?? stream.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error("MP4 视频时长无效或超过 30 秒验证上限");
      if (!["h264", "hevc", "av1", "vp9", "mpeg4"].includes(stream.codec_name)) throw new Error("MP4 未包含支持的视频编码轨道");
    }
    const frameLimit = kind === "image" ? 300 : 2000;
    const progress = await run(validators.ffmpeg, [...common, "-nostdin", "-xerror", "-err_detect", "crccheck+explode",
      ...input, "-i", path,
      "-map", `0:${stream.index}`, "-map", "0:a?", "-sn", "-dn", "-threads", "1", "-frames:v", String(frameLimit + 1),
      "-progress", "pipe:1", "-nostats", "-f", "null", "-"], signal);
    const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].map(match => Number(match[1]));
    const totalFrames = frames.at(-1);
    if (!totalFrames || totalFrames > frameLimit) throw new Error("媒体没有完整帧或超过验证帧数上限");
    signal.throwIfAborted();
    return { ext: ext || "mp4", width: stream.width, height: stream.height };
  } finally {
    // Only remove this call's fresh, private mkdtemp directory.
    if (dirname(dir) !== root || !basename(dir).startsWith("shengcheng-validate-")) throw new Error("媒体验证临时目录校验失败");
    await rm(dir, { recursive: true, force: true });
  }
}
