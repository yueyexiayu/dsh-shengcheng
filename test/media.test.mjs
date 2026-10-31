import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { officialFixture } from "./official-fixture.mjs";
import { execFileSync } from "node:child_process";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { generateImage, generateVideo, readReferenceImage } from "../lib/media.js";
import { MAX_REF_BYTES } from "../lib/parse.js";
import { preflightMediaValidation } from "../lib/validate-media.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const ctx = { credentials: { readRecord: async () => ({ kind: "grant", payload: {
  access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000,
} }) } };

async function withFixture(fn) {
  let cleanup;
  const f = await officialFixture({ after(value) { cleanup = value; } });
  try { return await fn(f.cwd, f.ctx.fs); } finally { await cleanup(); }
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

test("configured image model is sent unchanged for each provider and returned", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  for (const [provider, model] of [["grok", "grok-image-custom-4"], ["gpt", "gpt-image-custom-5"]]) {
    const result = await generateImage(ctx, { provider, prompt: "fixture", model });
    assert.equal(result.model, model);
    assert.equal(bodies.at(-1).model, model);
  }
});

test("unsupported model failure is not silently retried with a different model", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ error: { message: "unknown model" } }, { status: 400 });
  });
  await assert.rejects(generateImage(ctx, { provider: "grok", prompt: "fixture", model: "unsupported-model" }));
  assert.deepEqual(bodies.map(body => body.model), ["unsupported-model"]);
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

test("reference file validation reads valid images but rejects empty, fake and directory inputs", async () => withFixture(async (dir, fs) => {
  const path = join(dir, "ref.png");
  await writeFile(path, png);
  assert.equal((await readReferenceImage(path, dir, undefined, undefined, fs)).url, `data:image/png;base64,${png.toString("base64")}`);
  for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), png.subarray(0, 12)]) {
    await writeFile(path, bytes);
    await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /媒体|图片/);
  }
  await assert.rejects(readReferenceImage(dir, dir, undefined, undefined, fs), /普通文件/);
}));

test("oversized reference is rejected from official stat size before reading its sparse contents", async () => withFixture(async (dir, fs) => {
  const path = join(dir, "large.png");
  const file = await open(path, "wx");
  try { await file.truncate(MAX_REF_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /15MB/);
}));

test("FIFO reference is rejected without waiting for any writer", { skip: process.platform === "win32" }, async () => withFixture(async (dir, fs) => {
  const path = join(dir, "pipe.png");
  execFileSync("mkfifo", [path]);
  const before = Date.now();
  await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /普通文件/);
  assert.ok(Date.now() - before < 1000);
}));

test("cancelled reference read never opens the requested path", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readReferenceImage("/path/that/does/not/exist.png", null, controller.signal), { name: "AbortError" });
});

test("video polling can be cancelled during its wait without additional requests", async t => {
  const controller = new AbortController();
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    setTimeout(() => controller.abort(), 10);
    return Response.json({ request_id: "fixture-request" });
  });
  const before = Date.now();
  await assert.rejects(generateVideo(ctx, { prompt: "fixture", model: "grok-video-custom-4", signal: controller.signal }), { name: "AbortError" });
  assert.ok(Date.now() - before < 2000);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "grok-video-custom-4");
});

test("completed video returns the model used in its creation request", async t => {
  const { ffmpeg } = await preflightMediaValidation();
  const video = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:r=5", "-t", "1", "-c:v", "mpeg4", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), method: options.method ?? "GET", body: options.body && JSON.parse(options.body) });
    return options.method === "POST" ? Response.json({ request_id: "video-model-fixture" })
      : Response.json({ status: "done", video: { url: "https://cdn.example/fixture.mp4", duration: 1 } });
  });
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(https, "request", (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([video]);
      response.statusCode = 200;
      response.headers = { "content-type": "video/mp4" };
      callback(response);
    });
    return request;
  });
  const result = await generateVideo(ctx, { prompt: "fixture", model: "grok-video-configured" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.model, "grok-video-configured");
  assert.equal(result.model, requests[0].body.model);
  assert.equal(result.duration, 1);
  assert.deepEqual(result.bytes, video);
});
