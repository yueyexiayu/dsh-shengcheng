import test from "node:test";
import assert from "node:assert/strict";
import { currentProvider, registerShengchengTools, resolveGenerationDefaults } from "../lib/tools.js";
import { apply } from "../lib/index.js";

test("apply registers one tool", () => {
  const names = [];
  const ctx = {
    connection: { fetch: { register(route) { assert.equal(route.path, "/api/shengcheng/settings"); } } },
    tools: {
      register(tool) {
        names.push(tool.name);
        assert.equal(typeof tool.execute, "function");
        assert.equal(typeof tool.output.render, "function");
        assert.equal(tool.parameters.properties.kind.type, "string");
      },
    },
  };
  apply(ctx);
  assert.deepEqual(names, ["shengcheng"]);
});

test("registerShengchengTools fails visibly without its injected service", () => {
  assert.throws(() => registerShengchengTools({}), TypeError);
});

test("auto provider uses the active request header before global defaults", () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: "xai" }) }) };
  const exec = { agent: { session: { header: { config: { provider: "old-immutable-provider" } }, requestHeader: () => ({ config: { provider: "openai-codex" } }) } } };
  assert.equal(currentProvider(ctx, exec), "openai-codex");
});

test("provider fallback reads current settings through describe", () => {
  const ctx = { get: name => name === "settings" ? {
    describe: options => {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: "agent-default-model", value: { provider: "xai" } }];
    },
  } : undefined };
  assert.equal(currentProvider(ctx), "xai");
});

test("image defaults apply only to fields not specified in the request", () => {
  const settings = { provider: "gpt", imageAspectRatio: "3:2", imageQuality: "medium", videoResolution: "480p", videoDuration: 9 };
  assert.deepEqual(resolveGenerationDefaults({ prompt: "draw" }, settings), {
    prompt: "draw", provider: "gpt", aspect_ratio: "3:2", quality: "medium",
  });
  assert.deepEqual(resolveGenerationDefaults({ prompt: "draw", provider: "grok", aspect_ratio: "16:9", quality: "low", path: "x.png" }, settings), {
    prompt: "draw", provider: "grok", aspect_ratio: "16:9", quality: "low", path: "x.png",
  });
  assert.deepEqual(resolveGenerationDefaults({ prompt: "draw", size: "1024x1536" }, settings), {
    prompt: "draw", provider: "gpt", size: "1024x1536", quality: "medium",
  });
  assert.deepEqual(resolveGenerationDefaults({ prompt: "draw" }, { provider: "auto", imageAspectRatio: "auto", imageQuality: "auto" }), {
    prompt: "draw", provider: "auto",
  });
});

test("video defaults preserve Grok routing and explicit request values", () => {
  const settings = { provider: "gpt", imageAspectRatio: "3:2", imageQuality: "medium", videoResolution: "480p", videoDuration: 9 };
  assert.deepEqual(resolveGenerationDefaults({ prompt: "animate", kind: "video" }, settings), {
    prompt: "animate", kind: "video", resolution: "480p", duration: 9,
  });
  assert.deepEqual(resolveGenerationDefaults({ prompt: "animate", kind: "video", provider: "gpt", resolution: "1080p", duration: 3 }, settings), {
    prompt: "animate", kind: "video", provider: "gpt", resolution: "1080p", duration: 3,
  });
});

test("switching providers does not inherit incompatible image defaults", () => {
  assert.deepEqual(resolveGenerationDefaults(
    { prompt: "draw", provider: "gpt", quality: "high" },
    { provider: "grok", imageAspectRatio: "16:9", imageQuality: "medium" }, "gpt"),
  { prompt: "draw", provider: "gpt", quality: "high" });
  assert.deepEqual(resolveGenerationDefaults(
    { prompt: "draw", provider: "grok", aspect_ratio: "16:9" },
    { provider: "gpt", imageAspectRatio: "3:2", imageQuality: "high" }, "grok"),
  { prompt: "draw", provider: "grok", aspect_ratio: "16:9" });
  assert.deepEqual(resolveGenerationDefaults(
    { prompt: "draw" }, { provider: "grok", imageAspectRatio: "16:9", imageQuality: "medium" }, "grok"),
  { prompt: "draw", provider: "grok", aspect_ratio: "16:9", quality: "medium" });
});
