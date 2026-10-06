import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  FETCH_MS,
  GPT_RECORD_KEY,
  GROK_RECORD_KEY,
  grantFromRecord,
  httpErrorMessage,
} from "./parse.js";

export async function requestJson(url, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  let body;
  if (options.json) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
  }
  const signals = [AbortSignal.timeout(options.timeoutMs || FETCH_MS)];
  if (options.signal) signals.push(options.signal);
  const requestSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: requestSignal,
    });
  } catch (error) {
    requestSignal.throwIfAborted();
    if (error && error.name === "AbortError") throw error;
    throw new Error(error && error.message ? error.message : "网络请求失败");
  }
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { ok: response.ok, status: response.status, body: parsed, rawLength: raw.length };
}

const oauthProviders = { grok: xaiProvider().auth.oauth, gpt: openaiCodexProvider().auth.oauth };
const lastRefreshes = new WeakMap();

function accountIdentity(grant) {
  if (grant.accountId) return "account:" + grant.accountId;
  try {
    const payload = JSON.parse(Buffer.from(grant.access.split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.sub === "string" && payload.sub) return `subject:${payload.iss || ""}:${payload.sub}`;
  } catch { /* Opaque bearer tokens have no inspectable account identity. */ }
  return null;
}

function sameTokens(left, right) {
  return left.access === right.access && left.refresh === right.refresh;
}

function sameAccount(current, observed, transition) {
  const currentId = accountIdentity(current);
  const observedId = accountIdentity(observed);
  if (currentId && observedId) return currentId === observedId;
  // A retained refresh token, or this process's known rotation, proves continuity
  // even when Grok's access tokens are opaque. Unknown changes must stop the task.
  return current.refresh === observed.refresh || Boolean(transition
    && sameTokens(observed, transition.before) && sameTokens(current, transition.after));
}

function expiresSoon(grant) {
  return !Number.isFinite(grant.expires) || grant.expires <= Date.now() + 30_000;
}

export async function readGrant(ctx, recordKey, signal) {
  signal?.throwIfAborted();
  try {
    const grant = grantFromRecord(await ctx.credentials.readRecord(recordKey));
    signal?.throwIfAborted();
    return grant;
  } catch {
    signal?.throwIfAborted();
    throw new Error("读取登录凭据失败");
  }
}

async function refreshGrant(ctx, provider, observed, signal, force = false) {
  signal?.throwIfAborted();
  const recordKey = provider === "grok" ? GROK_RECORD_KEY : GPT_RECORD_KEY;
  const credentials = ctx.credentials;
  let transitions = lastRefreshes.get(credentials);
  if (!transitions) { transitions = new Map(); lastRefreshes.set(credentials, transitions); }
  let decisionError;
  let transition;
  let committed = false;
  try {
    const updated = await credentials.modifyRecord(recordKey, async (record) => {
      try {
        signal?.throwIfAborted();
        const current = grantFromRecord(record);
        if (!current) return undefined; // Logout while waiting: never recreate the record.
        const changed = !sameTokens(current, observed) || accountIdentity(current) !== accountIdentity(observed);
        if (changed && !sameAccount(current, observed, transitions.get(recordKey))) {
          throw new Error("登录凭据已变化，请重新发起任务");
        }
        if ((!force || changed) && !expiresSoon(current)) return undefined;
        const timeout = AbortSignal.timeout(15_000);
        const refreshSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let payload;
        try {
          payload = await oauthProviders[provider].refresh(record.payload, refreshSignal);
        } catch {
          refreshSignal.throwIfAborted();
          throw new Error(`${provider === "grok" ? "Grok" : "GPT"} 登录续期失败，请重新登录或稍后重试`);
        }
        refreshSignal.throwIfAborted();
        const next = grantFromRecord({ kind: "grant", payload });
        if (!next) throw new Error("登录续期没有返回有效凭据");
        const oldId = accountIdentity(current), newId = accountIdentity(next);
        if (oldId && newId && oldId !== newId) throw new Error("登录续期返回了其他账号，请重新登录");
        transition = { before: current, after: next };
        transitions.set(recordKey, transition);
        return { kind: "grant", payload };
      } catch (error) { decisionError = error; throw error; }
    });
    committed = true;
    signal?.throwIfAborted();
    return grantFromRecord(updated);
  } catch (error) {
    if (!committed && transition && transitions.get(recordKey) === transition) transitions.delete(recordKey);
    signal?.throwIfAborted();
    if (error === decisionError) throw error;
    throw new Error("保存登录凭据失败");
  }
}

export async function ensureGrant(ctx, provider, signal) {
  const recordKey = provider === "grok" ? GROK_RECORD_KEY : GPT_RECORD_KEY;
  const grant = await readGrant(ctx, recordKey, signal);
  if (!grant) return null;
  return expiresSoon(grant) ? refreshGrant(ctx, provider, grant, signal) : grant;
}

export async function authorizedJson(ctx, provider, makeRequest, signal) {
  let grant = await ensureGrant(ctx, provider, signal);
  if (!grant) {
    throw new Error(provider === "grok"
      ? "未登录 Grok，请先用输入框下方的 OAuth 登录"
      : "未登录 GPT，请先用输入框下方的 OAuth 登录");
  }
  const usedGrants = [grant];
  let res = await makeRequest(grant);
  signal?.throwIfAborted();
  if (res.status === 401) {
    grant = await refreshGrant(ctx, provider, grant, signal, true);
    if (!grant) throw new Error("未登录，请重新登录后发起任务");
    usedGrants.push(grant);
    res = await makeRequest(grant);
    signal?.throwIfAborted();
  }
  if (!res.ok) {
    const secrets = usedGrants.flatMap(value => [value.access, value.refresh]);
    const serialized = JSON.stringify(res.body, (_key, value) => typeof value === "string"
      ? secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED_SECRET]"), value) : value);
    throw new Error(httpErrorMessage(res.status, serialized === undefined ? undefined : JSON.parse(serialized)));
  }
  return res;
}

export function grokHeaders(grant) {
  return { authorization: `Bearer ${grant.access}` };
}

export function gptHeaders(grant) {
  const headers = {
    authorization: `Bearer ${grant.access}`,
    accept: "application/json",
    "user-agent": "codex-cli",
    originator: "codex_cli_rs",
  };
  if (grant.accountId) {
    headers["chatgpt-account-id"] = grant.accountId;
  }
  return headers;
}
