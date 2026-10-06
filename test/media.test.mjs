import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateImage, generateVideo, readReferenceImage, resolveOutPath, writeBytes } from "../lib/media.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=", "base64");
const ctx = { credentials: { readRecord: async () => ({ kind: "grant", payload: {
  access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000,
} }) } };

test("output extension follows actual media rather than the requested filename", () => {
  const options = { cwd: "/tmp", provider: "grok", kind: "image", ext: "jpg" };
  assert.equal(resolveOutPath("image.png", options), "/tmp/image.jpg");
  assert.equal(resolveOutPath("image.jpeg", options), "/tmp/image.jpeg");
  assert.equal(resolveOutPath("image", options), "/tmp/image.jpg");
  assert.equal(resolveOutPath("image.JPG", options), "/tmp/image.JPG");
  assert.equal(resolveOutPath("clip.png", { ...options, kind: "video", ext: "mp4" }), "/tmp/clip.mp4");
});

test("Grok download never sends account authorization to the returned CDN", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ data: [{ url: "https://cdn.example/image.png" }] });
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const result = await generateImage(ctx, { provider: "grok", prompt: "test" });
  assert.deepEqual(result.bytes, png);
  assert.equal(new Headers(calls[1].options.headers).has("authorization"), false);
});

test("HTML response is refused instead of being delivered as an image", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ data: [{ url: "https://cdn.example/error.png" }] })
    : new Response("<html>error</html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(generateImage(ctx, { provider: "grok", prompt: "test" }), /图片|文件|响应/);
  assert.equal(calls, 2);
});

test("base64 non-image is refused for either provider", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ b64_json: Buffer.from("error").toString("base64") }] }));
  for (const provider of ["grok", "gpt"]) {
    await assert.rejects(generateImage(ctx, { provider, prompt: "test" }), /图片/);
  }
});

test("download follows HTTPS redirects without authorization", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({ data: [{ url: "https://cdn.example/start" }] });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "https://other.example/image.png" } });
    return new Response(png);
  });
  assert.deepEqual((await generateImage(ctx, { provider: "grok", prompt: "test" })).bytes, png);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.redirect, "manual");
    assert.equal(new Headers(call.options.headers).has("authorization"), false);
  }
});

test("download refuses HTTP redirects", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ data: [{ url: "https://cdn.example/start" }] })
    : new Response(null, { status: 302, headers: { location: "http://cdn.example/image.png" } }));
  await assert.rejects(generateImage(ctx, { provider: "grok", prompt: "test" }), /HTTPS/);
  assert.equal(calls, 2);
});

test("cancelled download is not retried", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return Response.json({ data: [{ url: "https://cdn.example/start" }] });
    controller.abort();
    throw controller.signal.reason;
  });
  await assert.rejects(generateImage(ctx, { provider: "grok", prompt: "test", signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 2);
});

test("parallel saves cannot overwrite each other or existing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shengcheng-save-"));
  try {
    const path = join(dir, "image.png");
    const files = await Promise.all(Array.from({ length: 8 }, (_, i) => writeBytes(path, Buffer.from(`result-${i}`))));
    assert.equal(new Set(files).size, 8);
    for (let i = 0; i < files.length; i++) assert.equal((await readFile(files[i])).toString(), `result-${i}`);
    assert.equal((await readdir(dir)).length, 8);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reference files must contain images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shengcheng-ref-"));
  try {
    const path = await writeBytes(join(dir, "fake.png"), Buffer.from("<html>error</html>"));
    await assert.rejects(readReferenceImage(path, dir), /参考图|图片/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("video polling can be cancelled during its wait", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return Response.json({ request_id: "fixture-request" });
  });
  const before = Date.now();
  await assert.rejects(generateVideo(ctx, { prompt: "test", signal: controller.signal }), { name: "AbortError" });
  assert.ok(Date.now() - before < 1000);
  assert.equal(calls, 1);
});
