import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, settingsHandler, validateSettings } from "../lib/settings.js";

test("settings persist exact DSH routes and do not overwrite corrupt data", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "data", "settings.json"), handler = settingsHandler(path);
    const get = () => handler(new Request("http://localhost/api/shengcheng/settings"));
    const post = async settings => { const revision = (await (await get()).json()).revision; return handler(new Request("http://localhost/api/shengcheng/settings", { method: "POST", body: JSON.stringify({ settings, revision }) })); };
    assert.deepEqual((await (await get()).json()).settings, DEFAULT_SETTINGS);
    const chosen = { ...DEFAULT_SETTINGS, imageRoute: { provider: "gateway-a", model: "image-1" }, videoRoute: { provider: "gateway-b", model: "video-2" }, videoDuration: 8, outputDirectory: "output" };
    assert.equal((await post(chosen)).status, 200);
    assert.deepEqual(await loadSettings(path), chosen);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await post({ ...chosen, videoDuration: 3601 })).status, 400);
    assert.deepEqual(await loadSettings(path), chosen);
    await writeFile(path, "broken", "utf8");
    assert.equal((await get()).status, 500);
    assert.equal((await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ settings: DEFAULT_SETTINGS, revision: "absent" }) }))).status, 500);
    assert.equal(await readFile(path, "utf8"), "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy choices are preserved losslessly but not silently mapped to DSH routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "settings.json"), legacy = { provider: "grok", imageAspectRatio: "16:9", imageQuality: "medium", videoResolution: "1080p", videoDuration: 9, outputDirectory: "output", grokImageModel: "old-image", gptImageModel: "old-gpt", grokVideoModel: "old-video" };
    const original = JSON.stringify(legacy);
    await writeFile(path, original);
    const current = await loadSettings(path);
    assert.deepEqual(current, { imageRoute: null, videoRoute: null, imageFallbackRoute: null, videoFallbackRoute: null, imageAspectRatio: "16:9", imageQuality: "medium", videoResolution: "1080p", videoDuration: 9, outputDirectory: "output", legacySettings: legacy });
    assert.equal(await readFile(path, "utf8"), original);
    const handler = settingsHandler(path), next = { ...current, imageRoute: { provider: "route", model: "image" } };
    const revision = (await (await handler(new Request("http://localhost"))).json()).revision;
    assert.equal((await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ settings: next, revision }) }))).status, 200);
    assert.deepEqual((await loadSettings(path)).legacySettings, legacy);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete old settings are never overwritten and stale cross-Host saves are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "settings.json"), first = settingsHandler(path), second = settingsHandler(path);
    const request = (settings, revision) => new Request("http://localhost", { method: "POST", body: JSON.stringify({ settings, revision }) });
    const incomplete = JSON.stringify({ imageAspectRatio: "auto", imageQuality: "auto", videoResolution: "720p", videoDuration: 5, outputDirectory: "" });
    await writeFile(path, incomplete);
    assert.equal((await first(new Request("http://localhost"))).status, 500);
    assert.equal((await first(request(DEFAULT_SETTINGS, "absent"))).status, 500);
    assert.equal(await readFile(path, "utf8"), incomplete);
    await rm(path);
    const revision = (await (await first(new Request("http://localhost"))).json()).revision;
    const changed = { ...DEFAULT_SETTINGS, outputDirectory: "first" };
    assert.equal((await first(request(changed, revision))).status, 200);
    assert.equal((await second(request({ ...DEFAULT_SETTINGS, outputDirectory: "second" }, revision))).status, 409);
    assert.deepEqual(await loadSettings(path), changed);
    const latest = (await (await first(new Request("http://localhost"))).json()).revision;
    const attempts = await Promise.all([first(request({ ...changed, outputDirectory: "concurrent-a" }, latest)), second(request({ ...changed, outputDirectory: "concurrent-b" }, latest))]);
    assert.deepEqual(attempts.map(value => value.status).sort(), [200, 409]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid or partial model routes are rejected", () => {
  for (const imageRoute of [{ provider: "p" }, { provider: "", model: "m" }, { provider: "p", model: "m\n" }, "p/m"]) assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, imageRoute }));
});

test("settings from before fallback support gain empty fallback routes without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-settings-"));
  try {
    const path = join(root, "settings.json");
    const { imageFallbackRoute, videoFallbackRoute, ...old } = DEFAULT_SETTINGS;
    const body = JSON.stringify(old); await writeFile(path, body);
    assert.deepEqual(await loadSettings(path), DEFAULT_SETTINGS);
    assert.equal(await readFile(path, "utf8"), body);
  } finally { await rm(root, { recursive: true, force: true }); }
});
