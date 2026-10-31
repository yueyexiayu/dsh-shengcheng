import {
  defaultFileName,
  GPT_IMAGE_MODEL,
  GPT_QUALITIES,
  GROK_ASPECTS,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_QUALITIES,
  GROK_RECORD_KEY,
  GROK_VIDEO_MODEL,
  GPT_RECORD_KEY,
  VIDEO_TIMEOUT_MS,
  extForImageBytes,
  renderSaved,
  resolveImageProvider,
  resolveKind,
  resolveVideoProvider,
} from "./parse.js";
import { join } from "node:path";
import { readGrant } from "./oauth.js";
import { generateImage, generateVideo } from "./media.js";
import { prepareOutput, referencePath, sessionCwd, sessionProvider } from "./storage.js";
import { preflightMediaValidation } from "./validate-media.js";
import { gptQuality, gptSize, grokAspect, grokImageQuality, grokImageResolution, grokVideoResolution, videoDuration } from "./parse.js";

function currentProvider(ctx, exec) {
  const fromSession = sessionProvider(exec);
  if (fromSession) return fromSession;
  try {
    const agentDefaultModel = ctx.get && ctx.get("agentDefaultModel");
    const sel = agentDefaultModel && agentDefaultModel.currentSelection && agentDefaultModel.currentSelection();
    if (sel && typeof sel.provider === "string") return sel.provider;
  } catch {
    // optional
  }
  try {
    const settings = ctx.get && ctx.get("settings");
    const sel = settings?.describe({ redactSecrets: true }).find((row) => row.ns === "agent-default-model")?.value;
    if (sel && typeof sel.provider === "string") return sel.provider;
  } catch {
    // optional
  }
  return null;
}

async function loggedIn(ctx) {
  return {
    grokOk: Boolean(await readGrant(ctx, GROK_RECORD_KEY)),
    gptOk: Boolean(await readGrant(ctx, GPT_RECORD_KEY)),
  };
}

function promptOf(args) {
  const prompt = String(args && args.prompt || "").trim();
  if (!prompt) throw new Error("prompt 不能为空");
  return prompt;
}

// Explicit tool arguments always win. The "auto" image defaults intentionally
// leave the value unset so each provider retains its existing default.
export function resolveGenerationDefaults(args, settings = {}, resolvedProvider) {
  const kind = resolveKind(args?.kind);
  const effective = { ...args };
  if (effective.provider === undefined && kind === "image") effective.provider = settings.provider;
  if (kind === "image") {
    const provider = resolvedProvider ?? effective.provider;
    const aspect = settings.imageAspectRatio;
    const quality = settings.imageQuality;
    const aspectSupported = provider === "grok" ? GROK_ASPECTS.has(aspect) : ["1:1", "3:2", "2:3"].includes(aspect);
    const qualitySupported = provider === "grok" ? GROK_IMAGE_QUALITIES.has(quality) : provider === "gpt" ? GPT_QUALITIES.has(quality) : ["low", "medium"].includes(quality);
    if (effective.aspect_ratio === undefined && effective.size === undefined && aspect && aspect !== "auto" && aspectSupported) effective.aspect_ratio = aspect;
    if (effective.quality === undefined && quality && quality !== "auto" && qualitySupported) effective.quality = quality;
  } else {
    if (effective.resolution === undefined) effective.resolution = settings.videoResolution;
    if (effective.duration === undefined) effective.duration = settings.videoDuration;
  }
  return effective;
}

function shengchengTool(ctx, getDefaults) {
  return {
    name: "shengcheng",
    description:
      "Generate an image or video using the Grok or GPT account logged into DSH, subject to the generation endpoint accepting that account. Do not use API keys, bash, or curl. Works even if the current chat model is not Grok/GPT. kind=image (default) or video. Omit provider, aspect_ratio, quality, resolution, duration and path unless the user specifies them: saved plugin defaults are applied by the tool. Explicit provider=auto uses the current chat account when it is Grok or GPT, otherwise Grok if logged in, else GPT. Images: Grok grok-imagine-image-2.0 or GPT gpt-image-2. This tool supports videos only through Grok (grok-imagine-video-1.5). Requires ffmpeg and ffprobe for validation. Checks output permissions before generation. Saves a validated media file and returns its path; errors may mean generation or saving failed. If an error reports recoveryPath, recover that file rather than generating again. Inapplicable parameters are rejected.",
    timeoutMs: VIDEO_TIMEOUT_MS,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "Image or video prompt." },
        kind: { type: "string", enum: ["image", "video"], description: "image (default) or video." },
        provider: { type: "string", enum: ["grok", "gpt", "auto"], description: "grok, gpt, or auto. Omit to use the saved default. Video rejects gpt." },
        aspect_ratio: { type: "string", description: "Grok: e.g. 1:1, 16:9, 9:16. GPT: this plugin supports exact 1:1, 3:2, 2:3; no silent ratio substitution." },
        resolution: { type: "string", description: "Image (Grok): 1k or 2k. Video: 480p, 720p, or 1080p." },
        quality: { type: "string", description: "Image only. Grok: low|medium|auto. GPT: low|medium|high|auto." },
        size: { type: "string", description: "Image, GPT only, e.g. 1024x1024." },
        duration: { type: "integer", description: "Video length in seconds, 1-15. Omit to use the saved default." },
        image_path: { type: "string", description: "Video only: optional still image to animate." },
        path: { type: "string", description: "Optional output path. Relative paths use the session cwd, else Downloads." },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          path: { type: "string" },
          duration: { type: "number" },
        },
      },
      render(_args, value) {
        return renderSaved(value.path, `${value.provider} ${value.model}`);
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec?.signal;
      signal?.throwIfAborted();
      const settings = await getDefaults();
      const prompt = promptOf(args);
      const kind = resolveKind(args?.kind);
      const { grokOk, gptOk } = await loggedIn(ctx);
      const cwd = sessionCwd(exec);
      const provider = kind === "video"
        ? resolveVideoProvider({ requested: args?.provider, grokOk })
        : resolveImageProvider({ requested: args?.provider === undefined ? settings.provider : args.provider, current: currentProvider(ctx, exec), grokOk, gptOk });
      args = resolveGenerationDefaults(args, settings, provider);
      const reject = (keys) => {
        for (const key of keys) if (args[key] !== undefined) throw new Error(`${key} 不适用于 ${provider} ${kind}，请移除此参数`);
      };
      // Validate the entire selected branch before network or filesystem effects.
      if (kind === "video") {
        reject(["quality", "size"]);
        grokAspect(args.aspect_ratio, { video: true });
        grokVideoResolution(args.resolution);
        videoDuration(args.duration);
      } else {
        reject(["duration", "image_path"]);
        if (provider === "grok") {
          reject(["size"]);
          grokAspect(args.aspect_ratio);
          grokImageResolution(args.resolution);
          grokImageQuality(args.quality);
        } else {
          reject(["resolution"]);
          gptQuality(args.quality);
          gptSize(args.aspect_ratio, args.size);
        }
      }
      await preflightMediaValidation(signal);
      const ext = kind === "video" ? "mp4" : "png";
      const outputPath = args.path !== undefined || !settings.outputDirectory
        ? args.path : join(settings.outputDirectory, defaultFileName(provider, kind, ext));
      const output = await prepareOutput(ctx, exec, outputPath, { cwd, provider, kind, ext });
      try {
        const generated = kind === "video"
          ? await generateVideo(ctx, {
              prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution,
              duration: args.duration, imagePath: args.image_path === undefined ? undefined : await referencePath(ctx, exec, args.image_path, cwd), cwd, signal,
              validationDirectory: () => output.validationDirectory(),
            })
          : await generateImage(ctx, {
              provider, prompt, aspectRatio: args.aspect_ratio, resolution: args.resolution,
              quality: args.quality, size: args.size, signal,
              validationDirectory: () => output.validationDirectory(),
            });
        const dest = await output.save(generated.bytes, kind === "video" ? "mp4" : extForImageBytes(generated.bytes));
        return {
          kind, provider,
          model: kind === "video" ? GROK_VIDEO_MODEL : provider === "grok" ? GROK_IMAGE_MODEL : GPT_IMAGE_MODEL,
          path: dest, duration: generated.duration ?? 0,
        };
      } finally {
        await output.dispose();
      }
    },
  };
}

export function registerShengchengTools(ctx, getDefaults = () => ({})) {
  ctx.tools.register(shengchengTool(ctx, getDefaults));
  return 1;
}

export { currentProvider };
