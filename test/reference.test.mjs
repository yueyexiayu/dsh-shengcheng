import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { officialFixture } from "./official-fixture.mjs";
import { readReferenceImage } from "../lib/reference.js";
import { MAX_REF_BYTES } from "../lib/parse.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
async function withFixture(fn) {
  let cleanup;
  const f = await officialFixture({ after(value) { cleanup = value; } });
  try { return await fn(f.cwd, f.ctx.fs); } finally { await cleanup(); }
}
test("reference file returns validated bytes and rejects empty, fake and directory inputs", async () => withFixture(async (dir, fs) => {
  const path = join(dir, "ref.png");
  await writeFile(path, png);
  const result = await readReferenceImage(path, dir, undefined, undefined, fs);
  assert.deepEqual(result.bytes, png);
  assert.equal(result.mimeType, "image/png");
  for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), png.subarray(0, 12)]) {
    await writeFile(path, bytes);
    await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /媒体|图片/);
  }
  await assert.rejects(readReferenceImage(dir, dir, undefined, undefined, fs), /普通文件/);
}));
test("oversized reference is rejected before reading its sparse contents", async () => withFixture(async (dir, fs) => {
  const path = join(dir, "large.png"), file = await open(path, "wx");
  try { await file.truncate(MAX_REF_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /15MB/);
}));
test("FIFO reference is rejected without waiting for a writer", { skip: process.platform === "win32" }, async () => withFixture(async (dir, fs) => {
  const path = join(dir, "pipe.png"); execFileSync("mkfifo", [path]);
  const before = Date.now();
  await assert.rejects(readReferenceImage(path, dir, undefined, undefined, fs), /普通文件/);
  assert.ok(Date.now() - before < 1000);
}));
test("cancelled reference read never opens the requested path", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readReferenceImage("/path/that/does/not/exist.png", null, controller.signal), { name: "AbortError" });
});
