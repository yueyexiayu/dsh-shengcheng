import {
  FETCH_MS,
  GPT_RECORD_KEY,
  GROK_RECORD_KEY,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
  XAI_CLIENT_ID,
  XAI_REFRESH_SKEW_MS,
  XAI_TOKEN_URL,
  accountIdFromJwt,
  errorFromBody,
  grantFromRecord,
  httpErrorMessage,
} from "./parse.js";

export async function requestJson(url, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  let body;
  if (options.json) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const signals = [AbortSignal.timeout(options.timeoutMs || FETCH_MS)];
  if (options.signal) signals.push(options.signal);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  } catch (error) {
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

export async function xaiRefresh(grant) {
  const res = await requestJson(XAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: grant.refresh,
    },
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`Grok 刷新登录失败 (HTTP ${res.status})`);
  }
  const expiresIn = Number(res.body.expires_in);
  return {
    type: "oauth",
    access: res.body.access_token,
    refresh: res.body.refresh_token || grant.refresh,
    expires: Date.now() + ((expiresIn > 0 ? expiresIn : 3600) * 1000) - XAI_REFRESH_SKEW_MS,
  };
}

export async function openaiRefresh(grant) {
  const res = await requestJson(OPENAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      refresh_token: grant.refresh,
      client_id: OPENAI_CLIENT_ID,
    },
  });
  if (!res.ok || !res.body || !res.body.access_token || !res.body.refresh_token) {
    throw new Error(`GPT 刷新登录失败 (HTTP ${res.status})`);
  }
  const accountId = accountIdFromJwt(res.body.access_token) || grant.accountId;
  const expiresIn = Number(res.body.expires_in);
  return {
    type: "oauth",
    access: res.body.access_token,
    refresh: res.body.refresh_token,
    expires: Date.now() + (expiresIn > 0 ? expiresIn : 3600) * 1000,
    accountId: accountId || null,
  };
}

export async function readGrant(ctx, recordKey) {
  try {
    return grantFromRecord(await ctx.credentials.readRecord(recordKey));
  } catch {
    return null;
  }
}

export async function writeGrant(ctx, recordKey, payload) {
  try {
    await ctx.credentials.modifyRecord(recordKey, async () => ({
      kind: "grant",
      payload,
    }));
  } catch {
    // generation can still use the in-memory token
  }
}

async function refreshGrant(ctx, provider, grant) {
  const recordKey = provider === "grok" ? GROK_RECORD_KEY : GPT_RECORD_KEY;
  const payload = provider === "grok" ? await xaiRefresh(grant) : await openaiRefresh(grant);
  await writeGrant(ctx, recordKey, payload);
  return grantFromRecord({ kind: "grant", payload });
}

export async function ensureGrant(ctx, provider) {
  const recordKey = provider === "grok" ? GROK_RECORD_KEY : GPT_RECORD_KEY;
  let grant = await readGrant(ctx, recordKey);
  if (!grant) return null;
  if (grant.expires && grant.expires <= Date.now() + 30_000) {
    grant = await refreshGrant(ctx, provider, grant);
  }
  return grant;
}

export async function authorizedJson(ctx, provider, makeRequest) {
  let grant = await ensureGrant(ctx, provider);
  if (!grant) {
    throw new Error(provider === "grok"
      ? "未登录 Grok，请先用输入框下方的 OAuth 登录"
      : "未登录 GPT，请先用输入框下方的 OAuth 登录");
  }
  let res = await makeRequest(grant);
  if (res.status === 401) {
    grant = await refreshGrant(ctx, provider, grant);
    res = await makeRequest(grant);
  }
  if (!res.ok) {
    throw new Error(httpErrorMessage(res.status, res.body));
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
    headers["ChatGPT-Account-Id"] = grant.accountId;
  }
  return headers;
}

export { errorFromBody };
