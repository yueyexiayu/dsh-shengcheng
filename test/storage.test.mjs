import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, readdir, writeFile, mkdir, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { prepareOutput, resolveOutPath, sessionCwd, referencePath } from "../lib/storage.js";
import { registerShengchengTools } from "../lib/tools.js";
import { execFileSync } from "node:child_process";
import { preflightMediaValidation } from "../lib/validate-media.js";
import { MAX_IMAGE_BYTES } from "../lib/parse.js";

// Double models the inspected official resolve/checkedTarget/processPath contract;
// it is deliberately independent of the plugin's storage implementation.
export async function fixture(t, mode = "workspace-write") {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-storage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const state = { mode, checks: 0 };
  async function canonical(path) {
    try { return await realpath(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; return join(await canonical(dirname(path)), path.slice(dirname(path).length + 1)); }
  }
  const ctx = {
    sandboxPolicy: { resolve: ({ session }) => ({ mode: state.mode, workspaceRoot: session.header.cwd }) },
    fs: {
      resolve: async (path, options) => ({ displayPath: resolve(options?.cwd || cwd, path), targetKey: await canonical(resolve(options?.cwd || cwd, path)) }),
      processPath: target => target.targetKey,
      stat: async () => ({ type: "file", size: 3 }),
      readBytes: async target => readFile(target.targetKey),
      checkedTarget: async (target, policy) => {
        state.checks++;
        const fresh = { ...target, targetKey: await canonical(target.displayPath) };
        const rel = relative(await realpath(policy.workspaceRoot), fresh.targetKey);
        if (policy.mode === "read-only" || policy.mode === "workspace-write" && (rel === ".." || rel.startsWith("../") || isAbsolute(rel))) {
          const error = new Error("denied"); error.code = "FS_SANDBOX_DENIED"; throw error;
        }
        return fresh;
      },
    },
  };
  const controller = new AbortController();
  const exec = { agent: { session: { header: { cwd } } }, signal: controller.signal };
  return { root, cwd, ctx, exec, state, controller };
}
const options = cwd => ({ cwd, kind: "image", provider: "grok", ext: "png" });

test("policy rejects read-only and workspace escape before creating output", async t => {
  const f = await fixture(t, "read-only");
  await assert.rejects(prepareOutput(f.ctx, f.exec, "new/a.png", options(f.cwd)), /read-only/);
  assert.deepEqual(await readdir(f.cwd), []);
  f.state.mode = "workspace-write";
  await assert.rejects(prepareOutput(f.ctx, f.exec, "../outside/a.png", options(f.cwd)), /workspace-write/);
  assert.deepEqual(await readdir(f.root), ["workspace"]);
});

test("policy denies symlink escape, unsupported provider fails closed", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "outside"));
  await symlink(join(f.root, "outside"), join(f.cwd, "alias"));
  await assert.rejects(prepareOutput(f.ctx, f.exec, "alias/a.png", options(f.cwd)), /workspace-write/);
  delete f.ctx.fs.checkedTarget;
  await assert.rejects(prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd)), /不支持/);
});

test("full access writes outside cwd; atomic collision handling never overwrites", async t => {
  const f = await fixture(t, "danger-full-access");
  const path = join(f.root, "outside", "image.png");
  const first = await prepareOutput(f.ctx, f.exec, path, options(f.cwd));
  const second = await prepareOutput(f.ctx, f.exec, path, options(f.cwd));
  try {
    const paths = await Promise.all([first.save(Buffer.from("one"), "png"), second.save(Buffer.from("two"), "png")]);
    assert.equal(new Set(paths).size, 2);
    assert.deepEqual((await Promise.all(paths.map(p => readFile(p, "utf8")))).sort(), ["one", "two"]);
    assert.ok(f.state.checks >= 10);
  } finally { await first.dispose(); await second.dispose(); }
  assert.deepEqual((await readdir(dirname(path))).sort(), ["image-2.png", "image.png"]);
});

test("abort and generation failure cleanup leave no partial final output", async t => {
  const f = await fixture(t);
  const output = await prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd));
  f.controller.abort();
  await assert.rejects(output.save(Buffer.from("bytes"), "png"), { name: "AbortError" });
  await output.dispose();
  assert.deepEqual(await readdir(f.cwd), []);
});

test("policy is rechecked after generation and rejects mode changes", async t => {
  const f = await fixture(t);
  const output = await prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd));
  f.state.mode = "read-only";
  await assert.rejects(output.save(Buffer.from("bytes"), "png"), /read-only/);
  await output.dispose();
  assert.deepEqual(await readdir(f.cwd), []);
});

test("complete data retained when atomic publication fails", async t => {
  const f = await fixture(t);
  const output = await prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd));
  const original = f.ctx.fs.checkedTarget;
  f.ctx.fs.checkedTarget = async (target, policy) => {
    if (target.displayPath.endsWith("a.png")) throw new Error("publication denied fixture");
    return original(target, policy);
  };
  let recovery;
  await assert.rejects(output.save(Buffer.from("complete fixture bytes"), "png"), error => {
    recovery = error.recoveryPath; return /无需重新生成/.test(error.message) && Boolean(recovery);
  });
  await output.dispose();
  assert.equal(await readFile(recovery, "utf8"), "complete fixture bytes");
  assert.equal((await readdir(f.cwd)).length, 1);
});

test("bad paths fail preflight, actual extension respected, cwd read from request header", async t => {
  const f = await fixture(t);
  for (const raw of ["", "bad\0.png", "bad\n.png", ".", "..", "directory/"]) assert.throws(() => resolveOutPath(raw, options(f.cwd)));
  await writeFile(join(f.cwd, "blocked"), "not a directory");
  await assert.rejects(prepareOutput(f.ctx, f.exec, "blocked/a.png", options(f.cwd)));
  assert.equal(resolveOutPath("a.jpeg", { ...options(f.cwd), ext: "jpg" }), join(f.cwd, "a.jpeg"));
  assert.equal(sessionCwd({ agent: { session: { requestHeader: () => ({ cwd: f.cwd }) } } }), f.cwd);
});

test("replaced staging file is never published or falsely reported as recovery", async t => {
  const f = await fixture(t);
  const output = await prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd));
  const stage = join(f.cwd, (await readdir(f.cwd))[0]);
  await rename(stage, `${stage}.moved`);
  await writeFile(stage, "unvalidated replacement");
  await assert.rejects(output.save(Buffer.from("validated bytes"), "png"), error => /替换/.test(error.message) && !error.recoveryPath);
  await output.dispose();
  assert.equal(await readFile(stage, "utf8"), "unvalidated replacement");
  assert.ok(!(await readdir(f.cwd)).includes("a.png"));
});

test("official FS_ABORTED is mapped back to execution cancellation", async t => {
  const f = await fixture(t);
  f.ctx.fs.resolve = async () => { f.controller.abort(); const error = new Error("resolve aborted"); error.code = "FS_ABORTED"; throw error; };
  await assert.rejects(prepareOutput(f.ctx, f.exec, "a.png", options(f.cwd)), { name: "AbortError" });
  const g = await fixture(t);
  g.ctx.fs.resolve = async () => { g.controller.abort(); throw new Error("resolve aborted"); };
  await assert.rejects(referencePath(g.ctx, g.exec, "a.png", g.cwd), { name: "AbortError" });
});

test("reference resolves through read capability without using mutation fence", async t => {
  const f = await fixture(t, "read-only");
  const inside = join(f.cwd, "ref.png"), outside = join(f.root, "outside.png");
  await writeFile(inside, "png");
  await writeFile(outside, "png");
  await symlink(outside, join(f.cwd, "alias.png"));
  for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
    f.state.mode = mode;
    assert.equal(await referencePath(f.ctx, f.exec, "ref.png", f.cwd), await realpath(inside));
    assert.equal(await referencePath(f.ctx, f.exec, "alias.png", f.cwd), await realpath(outside));
    assert.equal(await referencePath(f.ctx, f.exec, "../outside.png", f.cwd), await realpath(outside));
  }
  assert.equal(f.state.checks, 0);
  delete f.ctx.fs.checkedTarget;
  assert.equal(await referencePath(f.ctx, f.exec, inside, f.cwd), await realpath(inside));
  delete f.ctx.fs.readBytes;
  await assert.rejects(referencePath(f.ctx, f.exec, inside, f.cwd), /不支持/);
});

async function toolFixture(t, mode, getDefaults) {
  const f = await fixture(t, mode);
  let tool;
  f.ctx.tools = { register: value => { tool = value; } };
  const routes = [
    { provider: "provider-a", id: "image-model", kind: "image", availability: "unverified" },
    { provider: "provider-b", id: "video-model", kind: "video", availability: "declared" },
    { provider: "provider-c", id: "override-model", kind: "image", availability: "declared" },
    { provider: "provider-d", id: "backup-video", kind: "video", availability: "declared" },
  ];
  const catalogSignals = [];
  f.ctx.llm = { listMediaModels: async (kind, provider, signal) => {
    assert.ok(signal instanceof AbortSignal);
    catalogSignals.push(signal);
    if (provider === undefined) throw new Error("another provider is unavailable");
    return routes.filter(route => route.kind === kind && route.provider === provider);
  } };
  registerShengchengTools(f.ctx, getDefaults);
  return { ...f, tool, catalogSignals };
}

test("Host route selection dispatches the chosen image model and applies explicit overrides", async t => {
  let settings = { imageRoute: { provider: "provider-a", model: "image-model" }, imageAspectRatio: "3:2", imageQuality: "medium", outputDirectory: "generated" };
  const f = await toolFixture(t, "workspace-write", async () => settings);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  const requests = [];
  f.ctx.llm.generateMedia = async options => { requests.push(options); return { provider: options.provider, model: options.model, kind: options.kind, bytes }; };
  const first = await f.tool.execute({ prompt: "first" }, f.exec);
  assert.equal(dirname(first.path), join(await realpath(f.cwd), "generated"));
  assert.equal(requests[0].provider, "provider-a");
  assert.equal(requests[0].model, "image-model");
  assert.equal(requests[0].signal, f.catalogSignals[0]);
  assert.equal(requests[0].aspectRatio, "3:2");
  assert.equal(requests[0].quality, "medium");
  assert.equal(first.provider, "provider-a");
  assert.equal(first.model, "image-model");
  const second = await f.tool.execute({ prompt: "second", provider: "provider-c", model: "override-model", aspect_ratio: "1:1", quality: "high", path: "explicit.png" }, f.exec);
  assert.equal(requests[1].provider, "provider-c");
  assert.equal(requests[1].model, "override-model");
  assert.equal(requests[1].aspectRatio, "1:1");
  assert.equal(requests[1].quality, "high");
  assert.equal(second.path, join(await realpath(f.cwd), "explicit.png"));
  settings = { ...settings, outputDirectory: "../outside" };
  await assert.rejects(f.tool.execute({ prompt: "third" }, f.exec), /workspace-write/);
  assert.equal(requests.length, 2, "sandbox rejection precedes generation");
});

test("unsupported route, mismatched response, or adapter failure never silently falls back", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, outputDirectory: "" }));
  let requests = 0;
  f.ctx.llm.generateMedia = async options => { requests++; if (requests === 1) return { ...options, provider: "provider-c", bytes: new Uint8Array([1]) }; throw new Error("adapter rejected model"); };
  await assert.rejects(f.tool.execute({ prompt: "test", provider: "unknown", model: "bad" }, f.exec), /目录失败/);
  assert.equal(requests, 0);
  await assert.rejects(f.tool.execute({ prompt: "test" }, f.exec), /不一致/);
  await assert.rejects(f.tool.execute({ prompt: "test" }, f.exec), /上游生成失败/);
  assert.equal(requests, 2);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("oversized adapter bytes are rejected and never published", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, outputDirectory: "" }));
  f.ctx.llm.generateMedia = async options => ({ provider: options.provider, model: options.model, kind: options.kind, bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) });
  await assert.rejects(f.tool.execute({ prompt: "test" }, f.exec), /超过大小上限/);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("image fallback runs once on upstream or media failure and reports the actual route", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  const calls = [];
  f.ctx.llm.generateMedia = async options => { calls.push(options); if (calls.length === 1) { const error = new Error("private upstream body"); error.code = "MEDIA_PROVIDER_ERROR"; throw error; } return { provider: options.provider, model: options.model, kind: options.kind, bytes: png }; };
  const result = await f.tool.execute({ prompt: "draw" }, f.exec);
  assert.deepEqual(calls.map(call => [call.provider, call.model]), [["provider-a", "image-model"], ["provider-c", "override-model"]]);
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.equal(result.provider, "provider-c"); assert.equal(result.model, "override-model");
  calls.length = 0;
  f.ctx.llm.generateMedia = async options => { calls.push(options); return { provider: options.provider, model: options.model, kind: options.kind, bytes: calls.length === 1 ? Buffer.from('invalid') : png }; };
  assert.equal((await f.tool.execute({ prompt: "draw" }, f.exec)).provider, "provider-c");
  assert.equal(calls.length, 2);
});

test("fallback failure reports both stages without leaking upstream bodies", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  let calls = 0;
  f.ctx.llm.generateMedia = async () => { calls++; const error = new Error("secret-url-and-token"); error.code = calls === 1 ? "MEDIA_TRANSPORT" : "INVALID_MEDIA_REQUEST"; throw error; };
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), error => /主模型 provider-a\/image-model/.test(error.message) && /兜底模型 provider-c\/override-model/.test(error.message) && /MEDIA_TRANSPORT/.test(error.message) && /INVALID_MEDIA_REQUEST/.test(error.message) && !/secret-url-and-token/.test(error.message));
  assert.equal(calls, 2);
});

test("single-route adapter and catalog failures do not expose upstream secrets", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, outputDirectory: "" }));
  const secret = "signed-url-or-token-secret";
  const original = f.ctx.llm.listMediaModels;
  f.ctx.llm.generateMedia = async () => { throw new Error("unexpected generation"); };
  f.ctx.llm.listMediaModels = async () => { throw Object.assign(new Error(secret), { code: "PRIVATE_SECRET" }); };
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), error => /目录失败/.test(error.message) && !error.message.includes(secret) && !error.message.includes("PRIVATE_SECRET"));
  f.ctx.llm.listMediaModels = original;
  for (const code of ["MEDIA_PROVIDER_ERROR", "INVALID_MEDIA_REQUEST", "PRIVATE_SECRET"]) {
    f.ctx.llm.generateMedia = async () => { throw Object.assign(new Error(secret), { code }); };
    await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), error => /上游生成失败/.test(error.message) && !error.message.includes(secret) && !error.message.includes("PRIVATE_SECRET"));
  }
});

test("upstream HTTP 400 and 422 may use the explicitly configured fallback", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  for (const status of [400, 422]) {
    const calls = [];
    f.ctx.llm.generateMedia = async options => { calls.push(options.provider); if (calls.length === 1) { const error = new Error(`media provider returned HTTP ${status}`); error.code = "MEDIA_PROVIDER_ERROR"; throw error; } return { provider: options.provider, model: options.model, kind: options.kind, bytes: png }; };
    assert.equal((await f.tool.execute({ prompt: "draw" }, f.exec)).provider, "provider-c");
    assert.deepEqual(calls, ["provider-a", "provider-c"]);
  }
});

test("route, authentication, and provider catalog failures can use fallback", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  for (const code of ["MEDIA_UNSUPPORTED", "MEDIA_ROUTE_CHANGED", "MEDIA_AUTH", "MISSING_CREDENTIAL"]) {
    const calls = [];
    f.ctx.llm.generateMedia = async options => { calls.push(options.provider); if (options.provider === "provider-a") { const error = new Error("route unavailable"); error.code = code; throw error; } return { provider: options.provider, model: options.model, kind: options.kind, bytes: png }; };
    assert.equal((await f.tool.execute({ prompt: "draw" }, f.exec)).provider, "provider-c");
    assert.deepEqual(calls, ["provider-a", "provider-c"]);
  }
  const original = f.ctx.llm.listMediaModels;
  for (const failure of ["throw", "missing"]) {
    f.ctx.llm.listMediaModels = async (kind, provider, signal) => { if (provider === "provider-a") { if (failure === "throw") throw new Error("catalog unavailable"); return []; } return original(kind, provider, signal); };
    f.ctx.llm.generateMedia = async options => ({ provider: options.provider, model: options.model, kind: options.kind, bytes: png });
    assert.equal((await f.tool.execute({ prompt: "draw" }, f.exec)).provider, "provider-c");
  }
});

test("a timed out primary receives one fresh 600-second fallback attempt", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  const original = AbortSignal.timeout;
  let deadlines = 0, calls = 0;
  try {
    AbortSignal.timeout = ms => ms === 600_000 && ++deadlines === 1 ? AbortSignal.abort(new DOMException("timed out", "TimeoutError")) : original(ms);
    f.ctx.llm.generateMedia = async options => { calls++; return { provider: options.provider, model: options.model, kind: options.kind, bytes: png }; };
    const result = await f.tool.execute({ prompt: "draw" }, f.exec);
    assert.equal(result.provider, "provider-c"); assert.equal(deadlines, 2); assert.equal(calls, 1);
  } finally { AbortSignal.timeout = original; }
});

test("two timed out attempts have independent deadlines and report both failures", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const original = AbortSignal.timeout;
  let deadlines = 0;
  try {
    AbortSignal.timeout = ms => ms === 600_000 ? (deadlines++, AbortSignal.abort(new DOMException("timed out", "TimeoutError"))) : original(ms);
    f.ctx.llm.generateMedia = async () => { throw new Error("timed out before generation"); };
    await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), error => /主模型 provider-a\/image-model：目录超时/.test(error.message) && /兜底模型 provider-c\/override-model：目录超时/.test(error.message));
    assert.equal(deadlines, 2);
  } finally { AbortSignal.timeout = original; }
});

test("a fallback identical to the resolved main route is never called twice", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-a", model: "image-model" }, outputDirectory: "" }));
  let calls = 0;
  f.ctx.llm.generateMedia = async () => { calls++; const error = new Error("failed"); error.code = "MEDIA_PROVIDER_ERROR"; throw error; };
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), /MEDIA_PROVIDER_ERROR/);
  assert.equal(calls, 1);
});

test("invalid input, local denial, and user cancellation never call fallback", async t => {
  const f = await toolFixture(t, "read-only", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  let calls = 0;
  f.ctx.llm.generateMedia = async () => { calls++; };
  await assert.rejects(f.tool.execute({ prompt: "" }, f.exec), /不能为空/);
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), /read-only/);
  assert.equal(calls, 0);
  f.state.mode = "workspace-write";
  f.ctx.llm.generateMedia = async () => { calls++; const error = new Error("bad request"); error.code = "INVALID_MEDIA_REQUEST"; throw error; };
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), /INVALID_MEDIA_REQUEST/);
  assert.equal(calls, 1);
  f.ctx.llm.generateMedia = async options => { calls++; f.controller.abort(); options.signal.throwIfAborted(); };
  await assert.rejects(f.tool.execute({ prompt: "draw" }, f.exec), { name: "AbortError" });
  assert.equal(calls, 2);
});

test("a local publication failure never triggers fallback", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, imageFallbackRoute: { provider: "provider-c", model: "override-model" }, outputDirectory: "" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  let calls = 0;
  f.ctx.llm.generateMedia = async options => { calls++; const original = f.ctx.fs.checkedTarget; f.ctx.fs.checkedTarget = async (target, policy) => { if (target.displayPath.endsWith("result.png")) throw new Error("publication denied"); return original(target, policy); }; return { provider: options.provider, model: options.model, kind: options.kind, bytes: png }; };
  await assert.rejects(f.tool.execute({ prompt: "draw", path: "result.png" }, f.exec), /无需重新生成/);
  assert.equal(calls, 1);
});

test("video uses its own exact route and cancellation is propagated", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ imageRoute: { provider: "provider-a", model: "image-model" }, videoRoute: { provider: "provider-b", model: "video-model" }, videoDuration: 8, videoResolution: "720p", outputDirectory: "" }));
  let actual;
  f.ctx.llm.generateMedia = async options => { actual = options; f.controller.abort(); options.signal.throwIfAborted(); };
  await assert.rejects(f.tool.execute({ prompt: "video", kind: "video" }, f.exec), { name: "AbortError" });
  assert.equal(actual.provider, "provider-b");
  assert.equal(actual.model, "video-model");
  assert.equal(actual.kind, "video");
  assert.equal(actual.duration, 8);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("video fallback uses its exact DSH route and its bytes are decoded before saving", async t => {
  const f = await toolFixture(t, "workspace-write", async () => ({ videoRoute: { provider: "provider-b", model: "video-model" }, videoFallbackRoute: { provider: "provider-d", model: "backup-video" }, videoDuration: 5, videoResolution: "720p", outputDirectory: "" }));
  const { ffmpeg } = await preflightMediaValidation();
  const bytes = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:r=5", "-t", "1", "-c:v", "mpeg4", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  const requests = [];
  f.ctx.llm.generateMedia = async options => { requests.push(options); if (requests.length === 1) { const error = new Error("upstream"); error.code = "MEDIA_PROVIDER_ERROR"; throw error; } return { provider: options.provider, model: options.model, kind: options.kind, bytes, duration: 1 }; };
  const result = await f.tool.execute({ kind: "video", prompt: "fixture", path: "result.mp4" }, f.exec);
  assert.deepEqual(requests.map(item => [item.provider, item.model]), [["provider-b", "video-model"], ["provider-d", "backup-video"]]);
  assert.equal(result.provider, "provider-d"); assert.equal(result.model, "backup-video");
  assert.equal(result.duration, 1); assert.deepEqual(await readFile(result.path), bytes);
});
