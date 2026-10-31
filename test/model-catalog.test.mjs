import test from "node:test";
import assert from "node:assert/strict";
import { listHostModelCatalog, modelCatalogHandler } from "../lib/model-catalog.js";

test("model selection retains provider identity and marks output only from media registry", async () => {
  const llm = {
    listProviders: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c" }],
    listModels: async provider => provider === "c" ? [] : [{ provider, id: "same", name: "Same", inputModalities: ["image"] }],
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
  assert.equal((await (await modelCatalogHandler(llm)()).json()).ok, true);
});

test("catalog failure stays unknown, does not leak errors, and is not a fake empty success", async () => {
  const llm = { listProviders: () => [{ id: "good" }, { id: "failed" }], listModels: async id => { if (id === "failed") throw new Error("secret-value"); return [{ provider: id, id: "m", name: "M" }]; }, listMediaModels: async () => { throw new Error("secret-value"); } };
  const result = await listHostModelCatalog(llm);
  assert.equal(result.groups.find(group => group.id === "good").models[0].image, "unknown");
  assert.equal(result.groups.find(group => group.id === "good").models[0].video, "unknown");
  assert.equal(result.failures[0].id, "failed");
  assert.equal(result.mediaFailures.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  assert.equal((await modelCatalogHandler({})()).status, 503);
});
