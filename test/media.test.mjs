import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { generateImage, generateVideo, readReferenceImage } from "../lib/media.js";
import { MAX_REF_BYTES } from "../lib/parse.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const ctx = { credentials: { readRecord: async () => ({ kind: "grant", payload: {
  access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000,
} }) } };

async function withFixture(fn) {
  const root = resolve(tmpdir());
  const dir = await mkdtemp(join(root, "shengcheng-ref-test-"));
  try { return await fn(dir); } finally {
    assert.equal(dirname(dir), root);
    assert.ok(basename(dir).startsWith("shengcheng-ref-test-"));
    await rm(dir, { recursive: true, force: true });
  }
}

test("Grok and GPT base64 responses are fully decoded before delivery", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  for (const provider of ["grok", "gpt"]) {
    assert.deepEqual((await generateImage(ctx, { provider, prompt: "fixture", aspectRatio: "3:2" })).bytes, png);
  }
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).size, "1536x1024");
});

test("base64 non-image and signature-only images fail for both providers", async t => {
  let payload = Buffer.from("error");
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ b64_json: payload.toString("base64") }] }));
  for (const provider of ["grok", "gpt"]) {
    await assert.rejects(generateImage(ctx, { provider, prompt: "fixture" }), /图片|媒体/);
    payload = png.subarray(0, 12);
    await assert.rejects(generateImage(ctx, { provider, prompt: "fixture" }), /图片|媒体/);
  }
});

test("pre-cancelled generation never reads credentials or sends requests", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("forbidden network"); });
  const forbidden = { credentials: { readRecord: () => { calls++; throw new Error("forbidden credential access"); } } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateImage(forbidden, { provider: "grok", prompt: "fixture", signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(generateVideo(forbidden, { prompt: "fixture", signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("reference file validation reads valid images but rejects empty, fake and directory inputs", async () => withFixture(async dir => {
  const path = join(dir, "ref.png");
  await writeFile(path, png);
  assert.equal((await readReferenceImage(path, dir)).url, `data:image/png;base64,${png.toString("base64")}`);
  for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), png.subarray(0, 12)]) {
    await writeFile(path, bytes);
    await assert.rejects(readReferenceImage(path, dir), /媒体|图片/);
  }
  await assert.rejects(readReferenceImage(dir, dir), /普通文件/);
}));

test("oversized reference is rejected from descriptor size before reading its sparse contents", async () => withFixture(async dir => {
  const path = join(dir, "large.png");
  const file = await open(path, "wx");
  try { await file.truncate(MAX_REF_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(readReferenceImage(path, dir), /15MB/);
}));

test("FIFO reference is rejected without waiting for any writer", { skip: process.platform === "win32" }, async () => withFixture(async dir => {
  const path = join(dir, "pipe.png");
  execFileSync("mkfifo", [path]);
  const before = Date.now();
  await assert.rejects(readReferenceImage(path, dir), /普通文件/);
  assert.ok(Date.now() - before < 1000);
}));

test("cancelled reference read never opens the requested path", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readReferenceImage("/path/that/does/not/exist.png", null, controller.signal), { name: "AbortError" });
});

test("video polling can be cancelled during its wait without additional requests", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return Response.json({ request_id: "fixture-request" });
  });
  const before = Date.now();
  await assert.rejects(generateVideo(ctx, { prompt: "fixture", signal: controller.signal }), { name: "AbortError" });
  assert.ok(Date.now() - before < 2000);
  assert.equal(calls, 1);
});
