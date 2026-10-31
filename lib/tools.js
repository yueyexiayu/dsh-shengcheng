import { join } from "node:path";
import { defaultFileName, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, renderSaved, resolveKind, MEDIA_TIMEOUT_MS } from "./parse.js";
import { prepareOutput, referencePath, sessionCwd } from "./storage.js";
import { downloadBytes } from "./network.js";
import { readReferenceImage } from "./reference.js";
import { preflightMediaValidation, validateMedia } from "./validate-media.js";

function mediaDiagnosticMessage(failure) {
  const messages = { submit_transport: "提交时连接发生异常", submit_http: "提交时收到异常 HTTP 响应", submit_invalid_json: "提交响应无法解析", submit_invalid_id: "提交响应没有有效的任务 ID", submit_response_too_large: "提交响应超过大小限制", submit_aborted: "提交过程被中断", poll_or_download: "任务状态查询或结果获取发生异常" };
  const category = failure?.mediaDiagnostic;
  if (typeof category !== "string" || !Object.hasOwn(messages, category)) return "";
  const status = Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599 ? `（HTTP ${failure.status}）` : "";
  return messages[category] + status;
}

// Catalog data is advisory only: never alter the request or infer why an upstream call failed.
async function catalogMismatchNotice(llm, route, args, signal) {
  if (typeof llm?.listMediaModels !== "function" || signal.aborted) return "";
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  let models, onAbort;
  try {
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(null);
      if (bounded.aborted) onAbort(); else bounded.addEventListener("abort", onAbort, { once: true });
    });
    models = await Promise.race([Promise.resolve().then(() => llm.listMediaModels("video", route.provider, bounded)), cancelled]);
  } catch { return ""; }
  finally { if (onAbort) bounded.removeEventListener("abort", onAbort); }
  if (!Array.isArray(models) || !models.every(model => model && model.provider === route.provider && model.kind === "video" && typeof model.id === "string" && ["declared", "unverified"].includes(model.availability))) return "";
  const matches = models.filter(model => model.id === route.model);
  if (matches.length !== 1 || !matches[0].parameters || typeof matches[0].parameters !== "object" || Array.isArray(matches[0].parameters)) return "";
  const { duration, resolutions } = matches[0].parameters, clues = [];
  if (duration && typeof duration === "object" && !Array.isArray(duration) && Number.isInteger(duration.min) && Number.isInteger(duration.max) && duration.min >= 1 && duration.max <= 3600 && duration.min <= duration.max && Number.isInteger(args.duration) && args.duration >= 1 && args.duration <= 3600 && (args.duration < duration.min || args.duration > duration.max)) {
    clues.push(`本次时长 ${args.duration} 秒，当前目录声明 ${duration.min}–${duration.max} 秒`);
  }
  const safeResolution = value => typeof value === "string" && /^(?:\d{2,5}p|\d{1,5}x\d{1,5}|\d{1,2}k)$/i.test(value);
  if (safeResolution(args.resolution) && Array.isArray(resolutions) && resolutions.length > 0 && resolutions.length <= 32 && resolutions.every(safeResolution) && !resolutions.some(value => value.toLowerCase() === args.resolution.toLowerCase())) {
    clues.push(`本次分辨率 ${args.resolution}，当前目录声明 ${resolutions.join("、")}`);
  }
  return clues.length ? `${clues.join("；")}。这只是排查线索，未必是 HTTP 503 的原因。` : "";
}

/** Explicit model selection takes precedence, while preserving provider identity. */
export function resolveRoute(args, settings, kind) {
  const saved = kind === "video" ? settings.videoRoute : settings.imageRoute;
  if (args.provider !== undefined && (typeof args.provider !== "string" || !args.provider.trim())) throw new Error("提供方无效");
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim())) throw new Error("模型 ID 无效");
  if (args.provider !== undefined && args.model === undefined && saved?.provider !== args.provider) throw new Error("指定不同提供方时请同时指定模型");
  const provider = args.provider ?? saved?.provider;
  const model = args.model ?? saved?.model;
  if (!provider || !model) throw new Error(`请先在生成插件设置中选择${kind === "video" ? "视频" : "图片"}模型，或同时指定 provider 和 model`);
  return { provider, model };
}

export function resolveGenerationDefaults(args, settings = {}) {
  const kind = resolveKind(args?.kind);
  const effective = { ...args };
  if (kind === "image") {
    if (effective.aspect_ratio === undefined && effective.size === undefined && settings.imageAspectRatio && settings.imageAspectRatio !== "auto") effective.aspect_ratio = settings.imageAspectRatio;
    if (effective.quality === undefined && settings.imageQuality && settings.imageQuality !== "auto") effective.quality = settings.imageQuality;
  } else {
    if (effective.resolution === undefined && settings.videoResolution && settings.videoResolution !== "auto") effective.resolution = settings.videoResolution;
    if (effective.duration === undefined && settings.videoDuration !== null) effective.duration = settings.videoDuration;
  }
  return effective;
}

export function generationSignal(signal) {
  const timeout = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeFailure(item, fallbackAttempted = false) {
  const codes = new Set(["INVALID_MEDIA_REQUEST", "INVALID_MEDIA_RESPONSE", "INVALID_CATALOG", "INVALID_CONFIG", "MEDIA_UNSUPPORTED", "MEDIA_CATALOG_UNAVAILABLE", "MEDIA_ROUTE_CHANGED", "MEDIA_AUTH", "MISSING_CREDENTIAL", "MEDIA_TRANSPORT", "MEDIA_PROVIDER_ERROR", "MEDIA_REQUEST_REJECTED", "MEDIA_RESPONSE_TOO_LARGE"]);
  const status = ["MEDIA_AUTH", "MEDIA_REQUEST_REJECTED"].includes(item?.error?.code) && Number.isInteger(item?.error?.failure?.status) && item.error.failure.status >= 100 && item.error.failure.status <= 599 ? `，HTTP ${item.error.failure.status}` : "";
  const code = codes.has(item?.error?.code) ? ` (${item.error.code}${status})` : "";
  const message = item?.error?.code === "MEDIA_REFERENCE_UNAVAILABLE" ? "无法确认所选提供方的参考图输入方式，尚未提交生成请求 (MEDIA_REFERENCE_UNAVAILABLE)" : item?.error?.code === "MEDIA_MODERATION_BLOCKED" ? "提供方内容审核拒绝了视频任务，未自动切换兜底 (MEDIA_MODERATION_BLOCKED)" : item?.error?.code === "MEDIA_JOB_UNCERTAIN" ? `上游任务状态未知，可能仍在运行；${fallbackAttempted ? "已尝试兜底" : "未自动切换兜底"}。${mediaDiagnosticMessage(item.error.failure) ? ` ${mediaDiagnosticMessage(item.error.failure)}。` : ""} (MEDIA_JOB_UNCERTAIN)` : item?.timeout ? `${item.phase}超时` : `${item?.phase || "未知阶段"}失败${code}`;
  return item?.catalogNotice ? `${message} ${item.catalogNotice}` : message;
}

function shengchengTool(ctx, getDefaults) {
  return {
    name: "shengcheng",
    description: "Generate an image or video using a DSH media-capable model route. User-requested parameters in the conversation take precedence over saved defaults. Supply provider, model, aspect_ratio, quality, resolution, duration and path only when the user explicitly requests them; prior assistant guesses or unsuccessful attempts are not user requirements. Omit unspecified parameters so saved plugin defaults apply. Switch routes only to the explicitly configured fallback after an eligible failure; report the actual provider and model. Output is validated before saving.",
    timeoutMs: 2 * MEDIA_TIMEOUT_MS + 10_000,
    parameters: { type: "object", additionalProperties: false, properties: {
      prompt: { type: "string", description: "Image or video prompt." },
      kind: { type: "string", enum: ["image", "video"], description: "image (default) or video." },
      provider: { type: "string", description: "Exact DSH provider route; omit to use the saved route. Specify model as well when switching provider." },
      model: { type: "string", description: "Exact DSH model ID; omit to use the saved route." },
      aspect_ratio: { type: "string", description: "Requested aspect ratio; adapter checks support." },
      resolution: { type: "string", description: "Resolution explicitly requested by the user; omit if unspecified. Earlier assistant guesses are not user requests. The adapter checks support." },
      quality: { type: "string", description: "Requested quality; adapter checks support." },
      size: { type: "string", description: "Requested output size; adapter checks support." },
      duration: { type: "integer", description: "Video duration in seconds explicitly requested by the user; omit if unspecified. The adapter checks support." },
      image_path: { type: "string", description: "Optional reference image path, where the selected adapter supports it." },
      path: { type: "string", description: "Optional output path. Relative paths use the session cwd, else Downloads." },
    }, required: ["prompt"] },
    output: { schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, path: { type: "string" }, duration: { type: "number" } } },
      render(_args, value) { return renderSaved(value.path, `${value.provider} ${value.model}`); } },
    isConcurrencySafe: () => false,
    async execute(input, exec) {
      exec?.signal?.throwIfAborted();
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) throw new Error("prompt 不能为空");
      const settings = await getDefaults();
      const kind = resolveKind(input.kind);
      const route = resolveRoute(input, settings, kind);
      const fallback = kind === "video" ? settings.videoFallbackRoute : settings.imageFallbackRoute;
      if (typeof ctx.llm?.generateMedia !== "function") throw new Error("当前 DSH Host 不提供媒体生成接口");
      const args = resolveGenerationDefaults(input, settings);
      const cwd = sessionCwd(exec);
      const ext = kind === "video" ? "mp4" : "png";
      async function attempt(selected) {
        const signal = generationSignal(exec?.signal);
        const boundedExec = Object.create(exec || null);
        Object.defineProperty(boundedExec, "signal", { value: signal });
        let phase = "请求准备", output, acceptedJob;
        try {
          signal.throwIfAborted();
          phase = "本地准备";
          const validators = await preflightMediaValidation(signal);
          const safeProvider = selected.provider.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "provider";
          const outputPath = args.path !== undefined || !settings.outputDirectory ? args.path : join(settings.outputDirectory, defaultFileName(safeProvider, kind, ext));
          output = await prepareOutput(ctx, boundedExec, outputPath, { cwd, provider: safeProvider, kind, ext });
          validators.validationDirectory = () => output.validationDirectory();
          const referenceImage = args.image_path === undefined ? undefined : await readReferenceImage(await referencePath(ctx, boundedExec, args.image_path, cwd), cwd, signal, validators, ctx.fs);
          phase = "上游生成";
          const generated = await ctx.llm.generateMedia({ ...selected, kind, prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution, quality: args.quality, size: args.size, duration: args.duration, referenceImage, signal, ...(kind === "video" ? { onJobAccepted: (jobId, routeFingerprint) => { acceptedJob = { jobId, routeFingerprint }; } } : {}) });
          signal.throwIfAborted();
          phase = "媒体响应";
          if (!generated || generated.provider !== selected.provider || generated.model !== selected.model || generated.kind !== kind) throw new Error("媒体生成结果与所选模型路线不一致");
          if (generated.duration !== undefined && (typeof generated.duration !== "number" || !Number.isFinite(generated.duration) || generated.duration < 0)) throw new Error("媒体生成结果时长无效");
          const hasBytes = generated.bytes instanceof Uint8Array;
          const hasUrl = typeof generated.url === "string" && generated.url.length > 0;
          if (hasBytes === hasUrl) throw new Error("媒体生成结果缺少唯一的字节或地址");
          const maximum = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
          const bytes = hasBytes ? Buffer.from(generated.bytes.buffer, generated.bytes.byteOffset, generated.bytes.byteLength) : await downloadBytes(generated.url, signal, maximum);
          const detected = await validateMedia(bytes, kind, signal, validators);
          phase = "本地保存";
          const dest = await output.save(bytes, detected.ext);
          return { kind, provider: selected.provider, model: selected.model, path: dest, duration: generated.duration ?? 0 };
        } catch (error) {
          if (exec?.signal?.aborted) throw exec.signal.reason;
          let confirmedFailed = false;
          const catalogNotice = kind === "video" && phase === "上游生成" && error?.code === "MEDIA_JOB_UNCERTAIN" && error?.failure?.mediaDiagnostic === "submit_http" && error.failure.status === 503
            ? await catalogMismatchNotice(ctx.llm, selected, args, signal) : "";
          if (kind === "video" && phase === "上游生成" && error?.code === "MEDIA_PROVIDER_ERROR" && acceptedJob && typeof ctx.llm.getMediaJobStatus === "function") {
            try {
              const job = await ctx.llm.getMediaJobStatus({ ...selected, ...acceptedJob, signal: AbortSignal.timeout(15000) });
              confirmedFailed = job?.provider === selected.provider && job?.model === selected.model && job?.jobId === acceptedJob.jobId && job.state === "failed";
              if (confirmedFailed && job.reason === "content_moderation") error = Object.assign(new Error("内容审核拒绝"), { code: "MEDIA_MODERATION_BLOCKED" });
            } catch { /* Unknown state does not start an automatic fallback. */ }
          }
          if (exec?.signal?.aborted) throw exec.signal.reason;
          const timeout = (signal.aborted && signal.reason?.name === "TimeoutError") || error?.name === "TimeoutError";
          const localFailure = ["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "ENOENT"].includes(error?.code);
          const referenceUnavailable = error?.code === "MEDIA_REFERENCE_UNAVAILABLE";
          const submission503 = kind === "video" && phase === "上游生成" && error?.code === "MEDIA_JOB_UNCERTAIN" && error?.failure?.mediaDiagnostic === "submit_http" && error.failure.status === 503;
          const uncertain = !referenceUnavailable && (error?.code === "MEDIA_JOB_UNCERTAIN" || (phase === "上游生成" && (timeout || error?.code === "MEDIA_TRANSPORT")));
          if (uncertain && error?.code !== "MEDIA_JOB_UNCERTAIN") error = Object.assign(new Error("上游任务状态未知"), { code: "MEDIA_JOB_UNCERTAIN" });
          const routeFailure = phase === "上游生成" && !localFailure && !["INVALID_MEDIA_REQUEST", "MEDIA_REFERENCE_UNAVAILABLE", "MEDIA_MODERATION_BLOCKED"].includes(error?.code) && !(kind === "video" && error?.code === "MEDIA_PROVIDER_ERROR" && !confirmedFailed);
          const media = phase === "媒体响应" && !localFailure && kind !== "video";
          throw { error, retryable: !referenceUnavailable && error?.code !== "MEDIA_MODERATION_BLOCKED" && (submission503 || (!uncertain && ((timeout && ["请求准备", "上游生成", "媒体响应"].includes(phase) && !(kind === "video" && phase === "媒体响应")) || routeFailure || media))), phase, timeout, catalogNotice };
        } finally { if (output) await output.dispose(); }
      }
      let primaryFailure;
      try { return await attempt(route); } catch (failure) { primaryFailure = failure; }
      exec?.signal?.throwIfAborted();
      if (!primaryFailure?.retryable || !fallback || (fallback.provider === route.provider && fallback.model === route.model)) {
        if (["请求准备", "上游生成"].includes(primaryFailure?.phase)) throw new Error(describeFailure(primaryFailure));
        throw primaryFailure?.error ?? primaryFailure;
      }
      try {
        return await attempt(fallback);
      } catch (failure) {
        exec?.signal?.throwIfAborted();
        throw new Error(`主模型 ${route.provider}/${route.model}：${describeFailure(primaryFailure, true)}；兜底模型 ${fallback.provider}/${fallback.model}：${describeFailure(failure)}`);
      }
    },
  };
}

export function registerShengchengTools(ctx, getDefaults = () => ({})) {
  ctx.tools.register(shengchengTool(ctx, getDefaults));
  return 1;
}
