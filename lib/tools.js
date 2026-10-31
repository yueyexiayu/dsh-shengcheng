import { join } from "node:path";
import { defaultFileName, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, renderSaved, resolveKind, MEDIA_TIMEOUT_MS } from "./parse.js";
import { prepareOutput, referencePath, sessionCwd } from "./storage.js";
import { downloadBytes } from "./network.js";
import { readReferenceImage } from "./reference.js";
import { preflightMediaValidation, validateMedia } from "./validate-media.js";
import { createVideoGuard, mediaDiagnosticMessage, safeMediaDiagnostic } from "./video-guard.js";

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
  const codes = new Set(["INVALID_MEDIA_REQUEST", "INVALID_MEDIA_RESPONSE", "INVALID_CATALOG", "INVALID_CONFIG", "MEDIA_UNSUPPORTED", "MEDIA_CATALOG_UNAVAILABLE", "MEDIA_ROUTE_CHANGED", "MEDIA_AUTH", "MISSING_CREDENTIAL", "MEDIA_TRANSPORT", "MEDIA_PROVIDER_ERROR", "MEDIA_REQUEST_REJECTED", "MEDIA_RESPONSE_TOO_LARGE"]);
  const status = ["MEDIA_AUTH", "MEDIA_REQUEST_REJECTED"].includes(item?.error?.code) && Number.isInteger(item?.error?.failure?.status) && item.error.failure.status >= 100 && item.error.failure.status <= 599 ? `，HTTP ${item.error.failure.status}` : "";
  const code = codes.has(item?.error?.code) ? ` (${item.error.code}${status})` : "";
  const message = item?.error?.code === "MEDIA_REFERENCE_UNAVAILABLE" ? "无法确认所选提供方的参考图输入方式，尚未提交生成请求 (MEDIA_REFERENCE_UNAVAILABLE)" : item?.error?.code === "MEDIA_MODERATION_BLOCKED" ? "提供方内容审核拒绝了视频任务，未自动切换兜底 (MEDIA_MODERATION_BLOCKED)" : item?.error?.code === "MEDIA_JOB_UNCERTAIN" ? `上游任务状态未知，可能仍在运行；未自动切换兜底。${item.error.hasJobId === false ? "未保存可用的任务 ID，无法确认是否已提交或查询状态。" : "如已保存任务 ID，请在生成插件设置中查询；完成后可在原会话恢复已有视频。"}${mediaDiagnosticMessage(item.error.diagnostic) ? ` ${mediaDiagnosticMessage(item.error.diagnostic)}。` : ""} (MEDIA_JOB_UNCERTAIN)` : item?.timeout ? `${item.phase}超时` : `${item?.phase || "未知阶段"}失败${code}`;
  return message;
}

function shengchengTool(ctx, getDefaults, guard) {
  return {
    name: "shengcheng",
    description: "Generate an image or video using a DSH media-capable model route. User-requested parameters in the conversation take precedence over saved defaults. Supply provider, model, aspect_ratio, quality, resolution, duration and path only when the user explicitly requests them; prior assistant guesses or unsuccessful attempts are not user requirements. Omit unspecified parameters so saved plugin defaults apply. Never resubmit an uncertain video task. Absence of a saved task record does not prove an older uncertain request was not accepted; do not resubmit it without external confirmation. If its status is confirmed completed, call with resume_video=true in the original session to retrieve the existing result without generating again. Switch routes only to the explicitly configured fallback after an eligible failure; report the actual provider and model. Output is validated before saving.",
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
      resume_video: { type: "boolean", description: "Recover the existing completed video job in this session without submitting a new generation request." },
      path: { type: "string", description: "Optional output path. Relative paths use the session cwd, else Downloads." },
    } },
    output: { schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, path: { type: "string" }, duration: { type: "number" } } },
      render(_args, value) { return renderSaved(value.path, `${value.provider} ${value.model}`); } },
    isConcurrencySafe: () => false,
    async execute(input, exec) {
      exec?.signal?.throwIfAborted();
      const resume = input?.resume_video === true;
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (!resume && !prompt) throw new Error("prompt 不能为空");
      const settings = await getDefaults();
      if (resume && input.kind !== undefined && input.kind !== "video") throw new Error("恢复视频时 kind 必须为 video 或留空");
      const kind = resume ? "video" : resolveKind(input.kind);
      const sessionId = exec?.agent?.session?.id;
      if (kind === "video" && (typeof sessionId !== "string" || !sessionId)) throw new Error("无法识别当前会话，不能安全提交或恢复视频任务");
      const prior = kind === "video" && input.resume_video ? guard.forSession(sessionId) : null;
      if (input.resume_video && !prior) throw new Error("此会话没有已记录的视频任务；不能据此认定旧请求未受理或安全重试");
      if (input.resume_video && (!prior.jobId || !prior.fingerprint)) throw new Error("此会话的视频任务未保存可用的任务 ID，无法查询或恢复；不能确认是否已受理，请先到提供方核实，勿重复提交");
      const route = prior ? { provider: prior.provider, model: prior.model } : resolveRoute(input, settings, kind);
      const fallback = kind === "video" ? settings.videoFallbackRoute : settings.imageFallbackRoute;
      if (typeof ctx.llm?.generateMedia !== "function") throw new Error("当前 DSH Host 不提供媒体生成接口");
      const args = resolveGenerationDefaults(input, settings);
      const cwd = sessionCwd(exec);
      const ext = kind === "video" ? "mp4" : "png";
      async function attempt(selected) {
        const signal = generationSignal(exec?.signal);
        const boundedExec = Object.create(exec || null);
        Object.defineProperty(boundedExec, "signal", { value: signal });
        let phase = "请求准备", output, lease, accepted = false;
        try {
          signal.throwIfAborted();
          phase = "本地准备";
          const validators = await preflightMediaValidation(signal);
          const safeProvider = selected.provider.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "provider";
          const outputPath = args.path !== undefined || !settings.outputDirectory ? args.path : join(settings.outputDirectory, defaultFileName(safeProvider, kind, ext));
          output = await prepareOutput(ctx, boundedExec, outputPath, { cwd, provider: safeProvider, kind, ext });
          validators.validationDirectory = () => output.validationDirectory();
          const referenceImage = prior || args.image_path === undefined ? undefined : await readReferenceImage(await referencePath(ctx, boundedExec, args.image_path, cwd), cwd, signal, validators, ctx.fs);
          phase = "上游生成";
          let generated;
          if (prior) {
            if (typeof ctx.llm.getMediaJobStatus !== "function" || typeof ctx.llm.fetchMediaJobResult !== "function") throw Object.assign(new Error("当前 Host 不支持恢复视频任务"), { code: "MEDIA_JOB_UNCERTAIN" });
            const options = { ...selected, jobId: prior.jobId, routeFingerprint: prior.fingerprint, signal };
            const status = await ctx.llm.getMediaJobStatus(options);
            if (status?.provider !== selected.provider || status?.model !== selected.model || status?.jobId !== prior.jobId || status.state !== "completed") throw Object.assign(new Error("视频任务尚未确认完成"), { code: "MEDIA_JOB_UNCERTAIN" });
            lease = { key: prior.session, token: prior.token };
            generated = await ctx.llm.fetchMediaJobResult(options);
          } else {
            if (kind === "video") {
              try { lease = guard.acquire(sessionId, selected); }
              catch (error) { throw Object.assign(error, { code: "MEDIA_JOB_UNCERTAIN" }); }
            }
            generated = await ctx.llm.generateMedia({ ...selected, kind, prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution, quality: args.quality, size: args.size, duration: args.duration, referenceImage, signal, ...(lease ? { onJobAccepted: (jobId, fingerprint) => { guard.accepted(lease, jobId, fingerprint); accepted = true; } } : {}) });
          }
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
          if (lease) guard.release(lease);
          return { kind, provider: selected.provider, model: selected.model, path: dest, duration: generated.duration ?? 0 };
        } catch (error) {
          if (lease && !prior && phase === "上游生成") {
            let definitive = ["INVALID_MEDIA_REQUEST", "INVALID_CONFIG", "MEDIA_UNSUPPORTED", "MEDIA_AUTH", "MISSING_CREDENTIAL", "MEDIA_REQUEST_REJECTED", "MEDIA_REFERENCE_UNAVAILABLE", "MEDIA_MODERATION_BLOCKED"].includes(error?.code);
            if (!definitive && error?.code === "MEDIA_PROVIDER_ERROR" && !exec?.signal?.aborted && typeof ctx.llm.getMediaJobStatus === "function") {
              const job = guard.forSession(sessionId);
              if (job?.jobId && job.fingerprint) {
                try {
                  const status = await ctx.llm.getMediaJobStatus({ provider: job.provider, model: job.model, jobId: job.jobId, routeFingerprint: job.fingerprint, signal: AbortSignal.timeout(15000) });
                  definitive = status?.provider === job.provider && status?.model === job.model && status?.jobId === job.jobId && status.state === "failed";
                  if (definitive && status.reason === "content_moderation") error = Object.assign(new Error("内容审核拒绝"), { code: "MEDIA_MODERATION_BLOCKED" });
                } catch { /* Unknown status retains the lock. */ }
              }
            }
            if (definitive) guard.release(lease);
            else {
              const diagnostic = safeMediaDiagnostic(error?.failure);
              try { guard.diagnose(lease, diagnostic); } catch { /* The existing protection remains authoritative. */ }
              error = Object.assign(new Error("上游任务状态未知"), { code: "MEDIA_JOB_UNCERTAIN", diagnostic, hasJobId: accepted });
            }
          }
          if (exec?.signal?.aborted) throw exec.signal.reason;
          const timeout = (signal.aborted && signal.reason?.name === "TimeoutError") || error?.name === "TimeoutError";
          const localFailure = ["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "ENOENT"].includes(error?.code);
          const referenceUnavailable = error?.code === "MEDIA_REFERENCE_UNAVAILABLE";
          const uncertain = !referenceUnavailable && (error?.code === "MEDIA_JOB_UNCERTAIN" || (phase === "上游生成" && (timeout || error?.code === "MEDIA_TRANSPORT")));
          if (uncertain && error?.code !== "MEDIA_JOB_UNCERTAIN") error = Object.assign(new Error("上游任务状态未知"), { code: "MEDIA_JOB_UNCERTAIN" });
          const routeFailure = phase === "上游生成" && !localFailure && !["INVALID_MEDIA_REQUEST", "MEDIA_REFERENCE_UNAVAILABLE", "MEDIA_MODERATION_BLOCKED"].includes(error?.code);
          const media = phase === "媒体响应" && !localFailure;
          throw { error, retryable: !prior && !uncertain && !referenceUnavailable && error?.code !== "MEDIA_MODERATION_BLOCKED" && ((timeout && ["请求准备", "上游生成", "媒体响应"].includes(phase)) || routeFailure || media), phase, timeout };
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
        throw new Error(`主模型 ${route.provider}/${route.model}：${describeFailure(primaryFailure)}；兜底模型 ${fallback.provider}/${fallback.model}：${describeFailure(failure)}`);
      }
    },
  };
}

export function registerShengchengTools(ctx, getDefaults = () => ({}), guard = createVideoGuard()) {
  ctx.tools.register(shengchengTool(ctx, getDefaults, guard));
  return 1;
}
