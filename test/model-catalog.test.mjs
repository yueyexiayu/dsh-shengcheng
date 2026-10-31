import test from "node:test";
import assert from "node:assert/strict";
import { listHostModelCatalog, modelCatalogHandler } from "../lib/model-catalog.js";

test("model selection retains provider identity and marks output only from media registry", async () => {
  const llm = {
    listProviders: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c" }],
    listModels: async provider => provider === "c" ? [] : [{ provider, id: "same", name: "Same", inputModalities: ["image"] }],
    generateMedia: () => {},
    listMediaModels: async (kind, provider) => kind === "image" && provider === "a" ? [{ provider, id: "same", name: "Same", kind, availability: "unverified" }] : kind === "image" && provider === "c" ? [{ provider, id: "image-only", kind, availability: "declared" }] : [],
  };
  const result = await listHostModelCatalog(llm);
  assert.deepEqual(result.groups, [
    { id: "a", name: "A", models: [{ id: "same", name: "Same", image: "unverified", video: "unavailable", imageParameters: null }] },
    { id: "b", name: "B", models: [{ id: "same", name: "Same", image: "unavailable", video: "unavailable" }] },
    { id: "c", name: "c", models: [{ id: "image-only", name: "image-only", image: "declared", video: "unavailable", imageParameters: null }] },
  ]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.mediaFailures, []);
  assert.equal(result.mediaEmpty.length, 4);
  assert.equal((await (await modelCatalogHandler(llm)()).json()).ok, true);
});

test("catalog failure stays unknown, does not leak errors, and is not a fake empty success", async () => {
  const llm = { listProviders: () => [{ id: "good" }, { id: "failed" }], listModels: async id => { if (id === "failed") throw new Error("secret-value"); return [{ provider: id, id: "m", name: "M" }]; }, generateMedia() {}, listMediaModels: async () => { throw new Error("secret-value"); } };
  const result = await listHostModelCatalog(llm);
  assert.equal(result.groups.find(group => group.id === "good").models[0].image, "unknown");
  assert.equal(result.groups.find(group => group.id === "good").models[0].video, "unknown");
  assert.equal(result.failures[0].id, "failed");
  assert.equal(result.mediaFailures.length, 4);
  assert.ok(result.mediaFailures.every(item => item.reason === "call_failed"));
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  assert.equal((await modelCatalogHandler({})()).status, 503);
});

test("distinguishes absent Host interfaces from failed and malformed directories", async () => {
  const base = { listProviders: () => [{ id: "p" }], listModels: () => [{ provider: "p", id: "chat", name: "Chat" }] };
  const missing = await listHostModelCatalog(base);
  assert.deepEqual(missing.mediaFailures[0], { provider: "p", kind: "image", reason: "interface_missing", missing: ["listMediaModels", "generateMedia"] });
  assert.equal(missing.groups[0].models[0].image, "unknown");
  const noGenerator = await listHostModelCatalog({ ...base, listMediaModels: () => [{ provider: "p", id: "chat", kind: "image", availability: "declared" }] });
  assert.deepEqual(noGenerator.mediaFailures[0].missing, ["generateMedia"]);
  assert.equal(noGenerator.groups[0].models[0].image, "unknown");
  const invalid = await listHostModelCatalog({ ...base, generateMedia() {}, listMediaModels: kind => kind === "image" ? [{ provider: "other", id: "x", kind, availability: "declared" }] : [] });
  assert.equal(invalid.mediaFailures[0].reason, "invalid_response");
  assert.deepEqual(invalid.mediaEmpty, [{ provider: "p", kind: "video" }]);
});

test("a later media-only model inherits the other kind's failed status", async () => {
  const result = await listHostModelCatalog({ listProviders: () => [{ id: "p" }], listModels: () => [], generateMedia() {}, listMediaModels(kind) { if (kind === "image") throw new Error("secret"); return [{ provider: "p", id: "v", kind, availability: "declared" }]; } });
  assert.equal(result.groups[0].models[0].image, "unknown");
  assert.equal(result.groups[0].models[0].video, "declared");
});
