import test from "node:test";
import assert from "node:assert/strict";
import { generationSignal, registerShengchengTools, resolveGenerationDefaults, resolveRoute } from "../lib/tools.js";
import { apply } from "../lib/index.js";

test("registers the generation tool and the two authenticated Host routes", () => {
  const names = [], paths = [];
  apply({ llm: {}, tools: { register(tool) { names.push(tool.name); assert.equal(typeof tool.execute, "function"); assert.equal(tool.timeoutMs, 1_210_000); } }, connection: { fetch: { register(route) { paths.push(route.path); } } } });
  assert.deepEqual(names, ["shengcheng"]);
  assert.deepEqual(paths, ["/api/shengcheng/settings", "/api/shengcheng/models"]);
  assert.throws(() => registerShengchengTools({}), TypeError);
});

test("generation deadline is 600 seconds and propagates upstream cancellation", () => {
  const original = AbortSignal.timeout;
  let delay;
  try {
    AbortSignal.timeout = value => { delay = value; return original(value); };
    const controller = new AbortController(), signal = generationSignal(controller.signal);
    assert.equal(delay, 600_000);
    controller.abort();
    assert.equal(signal.aborted, true);
  } finally { AbortSignal.timeout = original; }
});

test("keeps provider/model identity and explicit route takes precedence", () => {
  const settings = { imageRoute: { provider: "alpha", model: "same" }, videoRoute: { provider: "beta", model: "video" } };
  assert.deepEqual(resolveRoute({}, settings, "image"), { provider: "alpha", model: "same" });
  assert.deepEqual(resolveRoute({ provider: "gamma", model: "other" }, settings, "image"), { provider: "gamma", model: "other" });
  assert.deepEqual(resolveRoute({ model: "other" }, settings, "image"), { provider: "alpha", model: "other" });
  assert.deepEqual(resolveRoute({}, settings, "video"), { provider: "beta", model: "video" });
  assert.throws(() => resolveRoute({ provider: "gamma" }, settings, "image"), /同时指定模型/);
  assert.throws(() => resolveRoute({}, {}, "image"), /选择/);
});

test("explicit per-call settings override persisted defaults", () => {
  const settings = { imageAspectRatio: "3:2", imageQuality: "medium", videoResolution: "720p", videoDuration: 5 };
  assert.deepEqual(resolveGenerationDefaults({ prompt: "p" }, settings), { prompt: "p", aspect_ratio: "3:2", quality: "medium" });
  assert.deepEqual(resolveGenerationDefaults({ prompt: "p", size: "custom", quality: "high" }, settings), { prompt: "p", size: "custom", quality: "high" });
  assert.deepEqual(resolveGenerationDefaults({ kind: "video", duration: 3 }, settings), { kind: "video", duration: 3, resolution: "720p" });
});
