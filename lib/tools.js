import {
  GPT_IMAGE_MODEL,
  GROK_IMAGE_MODEL,
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
import { readGrant } from "./oauth.js";
import {
  generateImage,
  generateVideo,
  resolveOutPath,
  sessionCwd,
  sessionProvider,
  writeBytes,
} from "./media.js";

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
    const sel = settings && settings.get && settings.get("agent-default-model");
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

function shengchengTool(ctx) {
  return {
    name: "shengcheng",
    description:
      "Generate an image or video with the Grok or GPT account already logged into DSH. Do not use API keys, bash, or curl. Works even if the current chat model is not Grok/GPT. kind=image (default) or video. provider=auto uses the current chat account when it is Grok or GPT, otherwise Grok if logged in, else GPT. Images: Grok grok-imagine-image-2.0 or GPT gpt-image-2. Video is Grok-only (grok-imagine-video-1.5); GPT cannot generate video. Saves a file and returns its path.",
    timeoutMs: VIDEO_TIMEOUT_MS,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "Image or video prompt." },
        kind: { type: "string", description: "image (default) or video." },
        provider: { type: "string", description: "grok, gpt, or auto. Default auto. Video rejects gpt." },
        aspect_ratio: { type: "string", description: "e.g. 1:1, 16:9, 9:16." },
        resolution: { type: "string", description: "Image (Grok): 1k or 2k. Video: 480p, 720p, or 1080p." },
        quality: { type: "string", description: "Image only. Grok: low|medium|auto. GPT: low|medium|high|auto." },
        size: { type: "string", description: "Image, GPT only, e.g. 1024x1024." },
        duration: { type: "integer", description: "Video length in seconds, 1-15. Default 5." },
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
      const prompt = promptOf(args);
      const kind = resolveKind(args && args.kind);
      const { grokOk, gptOk } = await loggedIn(ctx);
      const cwd = sessionCwd(exec);
      const signal = exec && exec.signal;

      if (kind === "video") {
        resolveVideoProvider({ requested: args && args.provider, grokOk });
        const generated = await generateVideo(ctx, {
          prompt,
          aspectRatio: args && args.aspect_ratio,
          resolution: args && args.resolution,
          duration: args && args.duration,
          imagePath: args && args.image_path,
          cwd,
          signal,
        });
        const dest = await writeBytes(resolveOutPath(args && args.path, {
          cwd,
          provider: "grok",
          kind: "video",
          ext: "mp4",
        }), generated.bytes);
        return {
          kind: "video",
          provider: "grok",
          model: GROK_VIDEO_MODEL,
          path: dest,
          duration: generated.duration == null ? 0 : generated.duration,
        };
      }

      const provider = resolveImageProvider({
        requested: args && args.provider,
        current: currentProvider(ctx, exec),
        grokOk,
        gptOk,
      });
      const generated = await generateImage(ctx, {
        provider,
        prompt,
        aspectRatio: args && args.aspect_ratio,
        resolution: args && args.resolution,
        quality: args && args.quality,
        size: args && args.size,
        signal,
      });
      const dest = await writeBytes(resolveOutPath(args && args.path, {
        cwd,
        provider,
        kind: "image",
        ext: extForImageBytes(generated.bytes),
      }), generated.bytes);
      return {
        kind: "image",
        provider,
        model: provider === "grok" ? GROK_IMAGE_MODEL : GPT_IMAGE_MODEL,
        path: dest,
        duration: 0,
      };
    },
  };
}

export function registerShengchengTools(ctx) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== "function") return 0;
  ctx.tools.register(shengchengTool(ctx));
  return 1;
}

export { currentProvider };
