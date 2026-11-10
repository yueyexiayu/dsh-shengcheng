const CATALOG_TIMEOUT_MS = 8_000;
const CATALOG_CONCURRENCY = 4;

function catalogSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function bounded(work, signal, timeoutMs) {
  const boundedSignal = catalogSignal(signal, timeoutMs);
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(boundedSignal.reason);
    if (boundedSignal.aborted) rejectAbort(); else boundedSignal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
  finally { boundedSignal.removeEventListener("abort", rejectAbort); }
}

async function mapLimit(items, limit, work) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

/** The Host chat catalog and media registry are independent sources. */
export async function listHostModelCatalog(llm, { signal, timeoutMs = CATALOG_TIMEOUT_MS, concurrency = CATALOG_CONCURRENCY } = {}) {
  signal?.throwIfAborted();
  if (typeof llm?.listProviders !== "function" || typeof llm?.listModels !== "function") throw new Error("DSH 模型目录服务不可用");
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60_000) : CATALOG_TIMEOUT_MS;
  const width = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 16) : CATALOG_CONCURRENCY;
  const providers = await bounded(() => llm.listProviders(), signal, timeout);
  signal?.throwIfAborted();
  if (!Array.isArray(providers)) throw new Error("DSH 模型目录返回无效的提供方列表");
  const seenProviders = new Set();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== "string" || !provider.id || seenProviders.has(provider.id)) throw new Error("DSH 模型目录包含无效或重复的提供方");
    seenProviders.add(provider.id);
  }
  const failures = [];
  const groups = await mapLimit(providers, width, async provider => {
    const group = { id: provider.id, name: typeof provider.name === "string" && provider.name ? provider.name : provider.id, models: [] };
    try {
      const models = await bounded(() => llm.listModels(provider.id), signal, timeout);
      if (!Array.isArray(models)) throw new Error("invalid catalog");
      const seen = new Set();
      group.models = models.map(model => {
        if (!model || model.provider !== provider.id || typeof model.id !== "string" || !model.id || typeof model.name !== "string" || !model.name || seen.has(model.id)) throw new Error("invalid model");
        seen.add(model.id);
        return { id: model.id, name: model.name, image: "unavailable", video: "unavailable" };
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      failures.push({ id: group.id, name: group.name, message: error?.name === "TimeoutError" ? "模型列表读取超时" : "模型列表读取失败" });
    }
    return group;
  });
  signal?.throwIfAborted();
  const mediaFailures = [], mediaEmpty = [];
  const missing = ["listMediaModels", "generateMedia"].filter(method => typeof llm[method] !== "function");
  const requests = groups.flatMap(group => ["image", "video"].map(kind => ({ group, kind })));
  const catalogs = await mapLimit(requests, Math.min(width + 2, 12), async ({ group, kind }) => {
    let reason = null;
    if (missing.length) reason = "interface_missing";
    let models;
    if (!reason) {
      try { models = await bounded(() => llm.listMediaModels(kind, group.id), signal, timeout); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        reason = error?.name === "TimeoutError" ? "timeout" : error?.code === "MISSING_CREDENTIAL" ? "missing_credential" : error?.code === "INVALID_CONFIG" ? "invalid_config" : error?.code === "MEDIA_CATALOG_UNAVAILABLE" ? "catalog_unavailable" : "call_failed";
      }
    }
    if (!reason && (!Array.isArray(models) || models.some(model => !model || model.provider !== group.id || typeof model.id !== "string" || !model.id || model.kind !== kind || !["declared", "unverified"].includes(model.availability)))) reason = "invalid_response";
    return { group, kind, reason, models };
  });
  signal?.throwIfAborted();
  for (const { group, kind, reason, models } of catalogs) {
    if (reason) {
      mediaFailures.push({ provider: group.id, kind, reason, ...(reason === "interface_missing" ? { missing } : {}) });
      continue;
    }
    if (!models.length) mediaEmpty.push({ provider: group.id, kind });
    for (const model of models) {
      let item = group.models.find(entry => entry.id === model.id);
      if (!item) { item = { id: model.id, name: typeof model.name === "string" && model.name ? model.name : model.id, image: "unavailable", video: "unavailable" }; group.models.push(item); }
      item[kind] = model.availability;
      item[kind + "Parameters"] = model.parameters ?? null;
    }
  }
  // Apply failures after both kinds have added their models.
  for (const { provider, kind } of mediaFailures) {
    const group = groups.find(item => item.id === provider);
    for (const model of group.models) model[kind] = "unknown";
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  return { groups, failures, mediaFailures, mediaEmpty };
}

export function modelCatalogHandler(llm) {
  return async request => {
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    try {
      request?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ ok: true, catalog: await listHostModelCatalog(llm, { signal: request?.signal }) }), { headers });
    } catch {
      const aborted = request?.signal?.aborted === true;
      const status = aborted ? 499 : 503;
      return new Response(JSON.stringify({ ok: false, code: aborted ? "catalog_aborted" : "catalog_unavailable", error: aborted ? "模型目录请求已取消" : "DSH 模型目录不可用" }), { status, headers });
    }
  };
}
