import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { grantFromRecord } from "../lib/parse.js";
if (!process.env.DSH_OFFICIAL_ROOT) throw new Error("Set DSH_OFFICIAL_ROOT to test pi-ai compatibility against the installed official runtime.");
const official = name => import(pathToFileURL(join(process.env.DSH_OFFICIAL_ROOT, "node_modules/@earendil-works/pi-ai/dist/providers", name + ".js")));
const [{ xaiProvider: officialXai }, { openaiCodexProvider: officialCodex }] = await Promise.all([official("xai"), official("openai-codex")]);
for (const [name, oldFactory, currentFactory] of [["grok", xaiProvider, officialXai], ["gpt", openaiCodexProvider, officialCodex]]) {
  test(`${name}: pinned pi-ai 0.87.1 and official 1.0.2 refresh/toAuth grant shapes agree`, async t => {
    const access = name === "gpt" ? "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url") + ".signature" : "synthetic-access";
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, options) => { requests.push([String(url), options.body]); return Response.json({ access_token: access, refresh_token: "synthetic-rotated", expires_in: 3600 }); });
    const credential = { type: "oauth", access: "synthetic-expired", refresh: "synthetic-refresh", expires: 1, ...(name === "gpt" ? { accountId: "fixture-account" } : {}) };
    const results = [];
    for (const factory of [oldFactory, currentFactory]) {
      const oauth = factory().auth.oauth;
      const payload = await oauth.refresh(credential, new AbortController().signal);
      const grant = grantFromRecord({ kind: "grant", payload });
      assert.ok(grant); assert.equal(grant.access, access); assert.equal(grant.refresh, "synthetic-rotated");
      assert.ok(payload.expires > Date.now());
      results.push({ ...payload, expires: 0, auth: await oauth.toAuth(payload) });
    }
    assert.deepEqual(results[0], results[1]); assert.deepEqual(requests[0], requests[1]); assert.equal(requests.length, 2);
  });
}
