import { join } from "node:path";
import { defaultFileName, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, renderSaved, resolveKind, MEDIA_TIMEOUT_MS } from "./parse.js";
import { prepareOutput, referencePath, sessionCwd } from "./storage.js";
import { downloadBytes } from "./network.js";
import { readReferenceImage } from "./reference.js";
import { preflightMediaValidation, validateMedia } from "./validate-media.js";

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

function describeFailure(item) {
  if (item?.error?.code === "MEDIA_JOB_UNCERTAIN") return "上游任务状态未知，可能仍在运行；未自动切换兜底 (MEDIA_JOB_UNCERTAIN)";
  const codes = new Set(["INVALID_MEDIA_REQUEST", "INVALID_MEDIA_RESPONSE", "INVALID_CATALOG", "INVALID_CONFIG", "MEDIA_UNSUPPORTED", "MEDIA_ROUTE_CHANGED", "MEDIA_AUTH", "MISSING_CREDENTIAL", "MEDIA_TRANSPORT", "MEDIA_PROVIDER_ERROR", "MEDIA_RESPONSE_TOO_LARGE"]);
  const code = codes.has(item?.error?.code) ? ` (${item.error.code})` : "";
  return item?.timeout ? `${item.phase}超时` : `${item?.phase || "未知阶段"}失败${code}`;
}

function shengchengTool(ctx, getDefaults) {
  return {
    name: "shengcheng",
    description: "Generate an image or video using a DSH media-capable model route. Omit provider, model, aspect_ratio, quality, resolution, duration and path unless explicitly requested: saved plugin defaults apply. A model without a registered media adapter cannot generate media. Switch routes only to the explicitly configured fallback after an eligible failure; report the actual provider and model. Output is validated before saving.",
    timeoutMs: 2 * MEDIA_TIMEOUT_MS + 10_000,
    parameters: { type: "object", additionalProperties: false, properties: {
      prompt: { type: "string", description: "Image or video prompt." },
      kind: { type: "string", enum: ["image", "video"], description: "image (default) or video." },
      provider: { type: "string", description: "Exact DSH provider route; omit to use the saved route. Specify model as well when switching provider." },
      model: { type: "string", description: "Exact DSH model ID; omit to use the saved route." },
      aspect_ratio: { type: "string", description: "Requested aspect ratio; adapter checks support." },
      resolution: { type: "string", description: "Requested image or video resolution; adapter checks support." },
      quality: { type: "string", description: "Requested quality; adapter checks support." },
      size: { type: "string", description: "Requested output size; adapter checks support." },
      duration: { type: "integer", description: "Requested video duration in seconds; adapter checks support." },
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
      if (typeof ctx.llm?.listMediaModels !== "function" || typeof ctx.llm?.generateMedia !== "function") throw new Error("当前 DSH Host 不提供媒体生成接口");
      const args = resolveGenerationDefaults(input, settings);
      const cwd = sessionCwd(exec);
      const ext = kind === "video" ? "mp4" : "png";
      async function attempt(selected) {
        const signal = generationSignal(exec?.signal);
        const boundedExec = Object.create(exec || null);
        Object.defineProperty(boundedExec, "signal", { value: signal });
        let phase = "目录", output;
        try {
          signal.throwIfAborted();
          const models = await ctx.llm.listMediaModels(kind, selected.provider, signal);
          if (!Array.isArray(models)) throw new Error("DSH 媒体模型目录无效");
          if (!models.some(item => item?.kind === kind && item.provider === selected.provider && item.id === selected.model && ["declared", "unverified"].includes(item.availability))) throw new Error("所选 DSH 提供方和模型没有注册对应媒体生成能力，请重新选择");
          phase = "本地准备";
          const validators = await preflightMediaValidation(signal);
          const safeProvider = selected.provider.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "provider";
          const outputPath = args.path !== undefined || !settings.outputDirectory ? args.path : join(settings.outputDirectory, defaultFileName(safeProvider, kind, ext));
          output = await prepareOutput(ctx, boundedExec, outputPath, { cwd, provider: safeProvider, kind, ext });
          validators.validationDirectory = () => output.validationDirectory();
          const referenceImage = args.image_path === undefined ? undefined : await readReferenceImage(await referencePath(ctx, boundedExec, args.image_path, cwd), cwd, signal, validators, ctx.fs);
          phase = "上游生成";
          const generated = await ctx.llm.generateMedia({ ...selected, kind, prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution, quality: args.quality, size: args.size, duration: args.duration, referenceImage, signal });
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
          const timeout = (signal.aborted && signal.reason?.name === "TimeoutError") || error?.name === "TimeoutError";
          const localFailure = ["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "ENOENT"].includes(error?.code);
          const uncertain = error?.code === "MEDIA_JOB_UNCERTAIN" || (phase === "上游生成" && (timeout || error?.code === "MEDIA_TRANSPORT"));
          if (uncertain && error?.code !== "MEDIA_JOB_UNCERTAIN") error = Object.assign(new Error("上游任务状态未知"), { code: "MEDIA_JOB_UNCERTAIN" });
          const routeFailure = (phase === "目录" || phase === "上游生成") && !localFailure && error?.code !== "INVALID_MEDIA_REQUEST";
          const media = phase === "媒体响应" && !localFailure;
          throw { error, retryable: !uncertain && ((timeout && ["目录", "上游生成", "媒体响应"].includes(phase)) || routeFailure || media), phase, timeout };
        } finally { if (output) await output.dispose(); }
      }
      let primaryFailure;
      try { return await attempt(route); } catch (failure) { primaryFailure = failure; }
      exec?.signal?.throwIfAborted();
      if (!primaryFailure?.retryable || !fallback || (fallback.provider === route.provider && fallback.model === route.model)) {
        if (["目录", "上游生成"].includes(primaryFailure?.phase)) throw new Error(describeFailure(primaryFailure));
        throw primaryFailure?.error ?? primaryFailure;
      }
      try { return await attempt(fallback); } catch (failure) {
        exec?.signal?.throwIfAborted();
        throw new Error(`主模型 ${route.provider}/${route.model}：${describeFailure(primaryFailure)}；兜底模型 ${fallback.provider}/${fallback.model}：${describeFailure(failure)}`);
      }
    },
  };
}

export function registerShengchengTools(ctx, getDefaults = () => ({})) {
  ctx.tools.register(shengchengTool(ctx, getDefaults));
  return 1;
}
