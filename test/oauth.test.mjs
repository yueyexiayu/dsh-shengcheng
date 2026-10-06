import test from "node:test";
import assert from "node:assert/strict";
import { authorizedJson, ensureGrant, gptHeaders, readGrant, requestJson } from "../lib/oauth.js";

const key = "llm-pi-ai/xai";
const future = () => Date.now() + 3_600_000;
function record(account = "A", expired = false, provider = "grok") {
  const payload = { type: "oauth", access: `fixture-access-${account}`, refresh: `fixture-refresh-${account}`, expires: expired ? 1 : future() };
  if (provider === "gpt") payload.accountId = account;
  return { kind: "grant", payload };
}
function jwt(account) {
  return "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url") + ".signature";
}
function refreshed(provider = "grok", account = "A") {
  return Response.json({ access_token: provider === "gpt" ? jwt(account) : `fixture-renewed-${account}`, refresh_token: `fixture-rotated-${account}`, expires_in: 3600 });
}
function store(initial, { beforeModify, writeError } = {}) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  const credentials = {
    locked: false,
    readRecord: async () => structuredClone(value),
    replace: (next) => { value = structuredClone(next); },
    modifyRecord(_key, mutate) {
      const job = tail.then(async () => {
        await beforeModify?.(credentials);
        credentials.locked = true;
        try {
          const next = await mutate(structuredClone(value));
          if (writeError) throw writeError;
          if (next !== undefined) value = next;
          return structuredClone(value);
        } finally { credentials.locked = false; }
      });
      tail = job.then(() => undefined, () => undefined);
      return job;
    },
    deleteRecord: async () => { await tail; value = undefined; },
    value: () => structuredClone(value),
  };
  return credentials;
}

test("credential read errors remain visible and do not expose storage error details", async () => {
  await assert.rejects(() => readGrant({ credentials: { readRecord: async () => { throw new Error("fixture-storage-secret"); } } }, key), error => {
    assert.doesNotMatch(error.message, /fixture-storage-secret/);
    return true;
  });
});

for (const provider of ["grok", "gpt"]) {
  test(`${provider} uses official refresh inside the credential mutation lock`, async (t) => {
    const credentials = store(record("A", true, provider));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(credentials.locked, true);
      assert.ok(options.signal);
      calls++;
      return refreshed(provider);
    });
    const grant = await ensureGrant({ credentials }, provider);
    assert.notEqual(grant.access, record("A", true, provider).payload.access);
    assert.equal(credentials.value().payload.access, grant.access);
    assert.equal(calls, 1);
  });
}

test("a refresh whose credential write failed cannot return an in-memory success", async (t) => {
  const credentials = store(record("A", true), { writeError: new Error("fixture-storage-secret") });
  t.mock.method(globalThis, "fetch", async () => refreshed());
  await assert.rejects(() => ensureGrant({ credentials }, "grok"), error => {
    assert.doesNotMatch(error.message, /fixture-storage-secret/);
    return true;
  });
  assert.equal(credentials.value().payload.access, "fixture-access-A");
});

test("two expired-grant requests share one refresh after rechecking the current record", async (t) => {
  const credentials = store(record("A", true));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return refreshed(); });
  const grants = await Promise.all([ensureGrant({ credentials }, "grok"), ensureGrant({ credentials }, "grok")]);
  assert.equal(calls, 1);
  assert.equal(grants[0].access, grants[1].access);
});

for (const action of ["switch", "logout"]) {
  test(`${action} before the refresh lock is acquired cannot be overwritten`, async (t) => {
    let calls = 0;
    const credentials = store(record("A", true), { beforeModify: current => current.replace(action === "logout" ? undefined : record("B")) });
    t.mock.method(globalThis, "fetch", async () => { calls++; return refreshed(); });
    if (action === "logout") assert.equal(await ensureGrant({ credentials }, "grok"), null);
    else await assert.rejects(() => ensureGrant({ credentials }, "grok"), /变化/);
    assert.equal(calls, 0);
    assert.equal(credentials.value()?.payload.access, action === "logout" ? undefined : "fixture-access-B");
  });
}

test("concurrent 401 requests reuse the already refreshed opaque Grok grant", async (t) => {
  const credentials = store(record());
  let refreshCalls = 0;
  let requestCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { refreshCalls++; return refreshed(); });
  const request = async grant => {
    requestCalls++;
    return grant.access === "fixture-access-A" ? { ok: false, status: 401 } : { ok: true, status: 200 };
  };
  const results = await Promise.all([authorizedJson({ credentials }, "grok", request), authorizedJson({ credentials }, "grok", request)]);
  assert.equal(refreshCalls, 1);
  assert.equal(requestCalls, 4);
  assert.ok(results.every(result => result.ok));
});

for (const provider of ["grok", "gpt"]) {
  for (const action of ["switch", "logout"]) {
    test(`${provider} stale 401 after ${action} cannot refresh or retry with another account`, async (t) => {
      const credentials = store(record("A", false, provider));
      let refreshCalls = 0;
      let requestCalls = 0;
      t.mock.method(globalThis, "fetch", async () => { refreshCalls++; return refreshed(provider); });
      await assert.rejects(() => authorizedJson({ credentials }, provider, async () => {
        requestCalls++;
        await credentials.modifyRecord(undefined, async () => record("B", false, provider));
        if (action === "logout") await credentials.deleteRecord();
        return { ok: false, status: 401 };
      }), action === "logout" ? /未登录/ : /变化/);
      assert.equal(refreshCalls, 0);
      assert.equal(requestCalls, 1);
      assert.equal(credentials.value()?.payload.access, action === "logout" ? undefined : "fixture-access-B");
    });
  }
}

test("a stale GPT 401 reuses a confirmed same-account grant refreshed by another consumer", async (t) => {
  const credentials = store(record("A", false, "gpt"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("refresh must not run"); });
  const result = await authorizedJson({ credentials }, "gpt", async grant => {
    calls++;
    if (calls === 1) {
      const next = record("A", false, "gpt");
      next.payload.access = jwt("A");
      next.payload.refresh = "fixture-externally-rotated-A";
      await credentials.modifyRecord(undefined, async () => next);
      return { ok: false, status: 401 };
    }
    assert.equal(grant.access, jwt("A"));
    return { ok: true, status: 200 };
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

for (const reason of [new DOMException("fixture cancelled", "AbortError"), new DOMException("fixture timeout", "TimeoutError")]) {
  test(`${reason.name} reaches in-flight official refresh and prevents a late write`, async (t) => {
    const credentials = store(record("A", true));
    let arrived, resolveFetch, refreshSignal;
    const started = new Promise(resolve => { arrived = resolve; });
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      refreshSignal = options.signal;
      arrived();
      return new Promise(resolve => { resolveFetch = resolve; });
    });
    const controller = new AbortController();
    const pending = ensureGrant({ credentials }, "grok", controller.signal);
    const rejected = assert.rejects(pending, error => error.name === reason.name);
    await started;
    controller.abort(reason);
    const wasAborted = refreshSignal.aborted;
    resolveFetch(refreshed());
    await rejected;
    assert.equal(wasAborted, true);
    assert.equal(credentials.value().payload.access, "fixture-access-A");
  });
}

test("refresh error responses cannot expose upstream credential details", async (t) => {
  const credentials = store(record("A", true));
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "fixture-access-A", error_description: "fixture-refresh-A" }, { status: 400 }));
  await assert.rejects(() => ensureGrant({ credentials }, "grok"), error => {
    assert.doesNotMatch(error.message, /fixture-access-A|fixture-refresh-A/);
    return true;
  });
});

test("generation HTTP errors redact tokens before upstream detail is truncated", async () => {
  const credentials = store(record());
  await assert.rejects(() => authorizedJson({ credentials }, "grok", async () => ({ ok: false, status: 403, body: { error: `echo fixture-access-A fixture-refresh-A ${"x".repeat(350)}` } })), error => {
    assert.doesNotMatch(error.message, /fixture-access-A|fixture-refresh-A/);
    return true;
  });
});

test("GPT account headers contain one account id after Fetch normalization", () => {
  const headers = new Headers(gptHeaders({ access: "fixture-access", accountId: "fixture-account" }));
  assert.equal(headers.get("chatgpt-account-id"), "fixture-account");
});

test("JSON requests preserve the caller's TimeoutError category", async (t) => {
  const reason = new DOMException("fixture request deadline", "TimeoutError");
  t.mock.method(globalThis, "fetch", async (_url, options) => options.signal.throwIfAborted());
  await assert.rejects(() => requestJson("https://fixture.invalid", { signal: AbortSignal.abort(reason) }), error => error === reason);
});
