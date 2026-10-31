import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, settingsHandler, validateSettings } from "../lib/settings.js";

test("settings save persists validated defaults and reloads without changing a corrupt file", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "data", "settings.json");
    const handler = settingsHandler(path);
    const get = () => handler(new Request("http://localhost/api/shengcheng/settings"));
    const post = settings => handler(new Request("http://localhost/api/shengcheng/settings", { method: "POST", body: JSON.stringify({ settings }) }));
    assert.deepEqual((await (await get()).json()).settings, DEFAULT_SETTINGS);
    const chosen = { ...DEFAULT_SETTINGS, provider: "grok", imageAspectRatio: "16:9", videoDuration: 8, outputDirectory: "output" };
    assert.equal((await post(chosen)).status, 200);
    assert.deepEqual(await loadSettings(path), chosen);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await post({ ...chosen, videoDuration: 16 })).status, 400);
    assert.deepEqual(await loadSettings(path), chosen);
    await writeFile(path, "broken", "utf8");
    assert.equal((await get()).status, 500);
    assert.equal((await post(DEFAULT_SETTINGS)).status, 500);
    assert.equal(await readFile(path, "utf8"), "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings reject unavailable provider options", () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, provider: "gpt", imageAspectRatio: "16:9" }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, provider: "grok", imageQuality: "high" }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, provider: "auto", imageQuality: "high" }));
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, provider: "gpt", imageQuality: "high" }).imageQuality, "high");
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, grokImageModel: "bad model" }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, gptImageModel: "" }));
});

test("legacy saved settings gain model defaults without rewriting or discarding the existing choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "settings.json");
    const legacy = { provider: "grok", imageAspectRatio: "16:9", imageQuality: "medium", videoResolution: "1080p", videoDuration: 9, outputDirectory: "output" };
    const original = JSON.stringify(legacy);
    await writeFile(path, original);
    const current = await loadSettings(path);
    assert.deepEqual(current, { ...legacy, grokImageModel: "grok-imagine-image-2.0", gptImageModel: "gpt-image-2", grokVideoModel: "grok-imagine-video-1.5" });
    assert.equal(await readFile(path, "utf8"), original);
    delete legacy.videoDuration;
    await writeFile(path, JSON.stringify(legacy));
    await assert.rejects(loadSettings(path), /字段/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
