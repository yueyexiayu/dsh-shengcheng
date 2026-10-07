import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, readdir, writeFile, mkdir, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { prepareOutput, resolveOutPath, sessionCwd, referencePath } from "../lib/storage.js";
import { registerShengchengTools } from "../lib/tools.js";

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

async function toolFixture(t, mode) {
  const f = await fixture(t, mode);
  let tool;
  f.ctx.tools = { register: value => { tool = value; } };
  f.ctx.credentials = { readRecord: async () => ({ kind: "grant", payload: {
    access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000,
  } }) };
  registerShengchengTools(f.ctx);
  return { ...f, tool };
}

test("full registered tool rejects policy, bad paths and inapplicable parameters before paid requests", async t => {
  const f = await toolFixture(t, "read-only");
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("unexpected request"); });
  await assert.rejects(f.tool.execute({ prompt: "fixture", provider: "grok" }, f.exec), /read-only/);
  f.state.mode = "workspace-write";
  await assert.rejects(f.tool.execute({ prompt: "fixture", path: "../outside.png" }, f.exec), /workspace-write/);
  await assert.rejects(f.tool.execute({ prompt: "fixture", path: "invalid\0.png" }, f.exec), /控制字符/);
  for (const args of [
    { provider: "grok", duration: 5 }, { provider: "grok", image_path: "ref.png" },
    { provider: "grok", size: "1024x1024" }, { provider: "gpt", resolution: "1k" },
    { kind: "video", quality: "high" }, { kind: "video", size: "1024x1024" },
    { provider: "gpt", aspect_ratio: "16:9" }, { provider: "gpt", aspect_ratio: "bad-ratio" },
  ]) await assert.rejects(f.tool.execute({ prompt: "fixture", ...args }, f.exec));
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("full tool saves decoded media through checked filesystem and renders lossless path", async t => {
  const f = await toolFixture(t, "workspace-write");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }); });
  const args = { prompt: "fixture", provider: "grok", path: "图片 'quoted' image.png" };
  const result = await f.tool.execute(args, f.exec);
  assert.equal(requests, 1);
  assert.deepEqual(await readFile(result.path), bytes);
  const rendered = f.tool.output.render(args, result)[0].text;
  assert.equal(JSON.parse(rendered.split("shengcheng_result ")[1]).path, result.path);
  assert.deepEqual(await readdir(f.cwd), ["图片 'quoted' image.png"]);
  assert.ok(f.state.checks > 5);
});

test("failed or cancelled generation cleans preflight staging without final output", async t => {
  const f = await toolFixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "synthetic-access rejected" } }, { status: 403 }));
  await assert.rejects(f.tool.execute({ prompt: "fixture", provider: "grok" }, f.exec), error => !error.message.includes("synthetic-access"));
  assert.deepEqual(await readdir(f.cwd), []);
  t.mock.method(globalThis, "fetch", async () => { f.controller.abort(); throw f.controller.signal.reason; });
  await assert.rejects(f.tool.execute({ prompt: "fixture", provider: "grok" }, f.exec), { name: "AbortError" });
  assert.deepEqual(await readdir(f.cwd), []);
});
