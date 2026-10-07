import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateMedia, preflightMediaValidation } from "../lib/validate-media.js";

const exec = promisify(execFile);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

async function generated(args) {
  const { ffmpeg } = await preflightMediaValidation();
  return (await exec(ffmpeg, ["-v", "error", ...args], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024, timeout: 10_000 })).stdout;
}

test("actual decoder accepts valid PNG JPEG WebP and GIF", async () => {
  assert.equal((await validateMedia(png, "image")).ext, "png");
  const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  assert.equal((await validateMedia(webp, "image")).ext, "webp");
  for (const [codec, ext] of [["mjpeg", "jpg"], ["gif", "gif"]]) {
    const bytes = await generated(["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-c:v", codec, "-f", "image2pipe", "pipe:1"]);
    assert.equal((await validateMedia(bytes, "image")).ext, ext);
  }
});

test("12-byte signatures and truncated image data are not valid images", async () => {
  for (const bytes of [png.subarray(0, 12), png.subarray(0, 40), Buffer.from([255,216,255,0,0,0,0,0,0,0,0,0])]) {
    await assert.rejects(validateMedia(bytes, "image"), /媒体|图片|轨道/);
  }
});

test("actual video decoding rejects fake ftyp, audio-only MP4 and truncated video", async () => {
  await assert.rejects(validateMedia(Buffer.from([0,0,0,12,102,116,121,112,104,101,105,99]), "video"));
  const args = ["-f", "lavfi", "-i", "color=c=red:s=16x16:r=5", "-t", "1", "-c:v", "mpeg4", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"];
  const video = await generated(args);
  assert.deepEqual(await validateMedia(video, "video"), { ext: "mp4", width: 16, height: 16 });
  await assert.rejects(validateMedia(video.subarray(0, Math.floor(video.length / 2)), "video"));
  const audio = await generated(["-f", "lavfi", "-i", "sine=frequency=1000", "-t", "0.1", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  await assert.rejects(validateMedia(audio, "video"), /轨道/);
});

test("corrupt late audio packets fail even with a valid video track", async () => {
  const root = resolve(tmpdir());
  const dir = await mkdtemp(join(root, "shengcheng-audio-test-"));
  try {
    const video = await generated(["-f", "lavfi", "-i", "color=c=red:s=16x16:r=5", "-f", "lavfi", "-i", "sine=frequency=1000", "-t", "1", "-c:v", "mpeg4", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
    assert.equal((await validateMedia(video, "video")).ext, "mp4");
    const path = join(dir, "audio.mp4");
    await writeFile(path, video);
    const validators = await preflightMediaValidation();
    const { stdout } = await exec(validators.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pos,size", "-of", "json", path]);
    const packets = JSON.parse(stdout).packets;
    assert.ok(packets.length > 5);
    for (const packet of packets.slice(-3)) video.fill(255, Number(packet.pos), Number(packet.pos) + Number(packet.size));
    await assert.rejects(validateMedia(video, "video"), /媒体/);
  } finally {
    assert.equal(dirname(dir), root);
    assert.ok(basename(dir).startsWith("shengcheng-audio-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("PNG checksum corruption is rejected even when pixels can be recovered", async () => {
  const invalid = Buffer.from(png);
  invalid[52] ^= 1;
  await assert.rejects(validateMedia(invalid, "image"), /媒体/);
});

test("pre-aborted validation never starts a decoder", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateMedia(png, "image", controller.signal), { name: "AbortError" });
  await assert.rejects(preflightMediaValidation(controller.signal), { name: "AbortError" });
});

test("validation staging uses the authorized callback and removes its private directory", async () => {
  const root = resolve(tmpdir());
  const dir = await mkdtemp(join(root, "shengcheng-staging-test-"));
  try {
    const validators = await preflightMediaValidation();
    let calls = 0;
    validators.validationDirectory = async () => { calls++; return dir; };
    await validateMedia(png, "image", undefined, validators);
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(dir), []);
    validators.validationDirectory = async () => { throw new Error("fixture permission denied"); };
    await assert.rejects(validateMedia(png, "image", undefined, validators), /fixture permission denied/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    assert.equal(dirname(dir), root);
    assert.ok(basename(dir).startsWith("shengcheng-staging-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelling an active validator kills and reaps its child process", async () => {
  const root = resolve(tmpdir());
  const dir = await mkdtemp(join(root, "shengcheng-validator-test-"));
  try {
    const marker = join(dir, "pid");
    const binary = join(dir, "slow-validator");
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const result = validateMedia(png, "image", controller.signal, { ffprobe: binary, ffmpeg: binary });
    const rejection = result.catch(error => error);
    let pid;
    for (let i = 0; i < 500; i++) {
      try { pid = Number(await readFile(marker, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    controller.abort();
    const error = await rejection;
    assert.ok(pid, `validator subprocess did not start: ${error?.message}`);
    assert.equal(error.name, "AbortError");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    assert.equal(dirname(dir), root);
    assert.ok(basename(dir).startsWith("shengcheng-validator-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});
