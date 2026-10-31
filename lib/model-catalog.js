/** The Host chat catalog and media registry are independent sources. */
export async function listHostModelCatalog(llm) {
  if (typeof llm?.listProviders !== "function" || typeof llm?.listModels !== "function") throw new Error("DSH 模型目录服务不可用");
  const providers = await llm.listProviders();
  if (!Array.isArray(providers)) throw new Error("DSH 模型目录返回无效的提供方列表");
  const groups = [], failures = [];
  await Promise.all(providers.map(async provider => {
    if (!provider || typeof provider.id !== "string" || !provider.id) throw new Error("DSH 模型目录包含无效的提供方");
    const group = { id: provider.id, name: typeof provider.name === "string" && provider.name ? provider.name : provider.id, models: [] };
    try {
      const models = await llm.listModels(provider.id);
      if (!Array.isArray(models)) throw new Error("invalid catalog");
      const seen = new Set();
      group.models = models.map(model => {
        if (!model || model.provider !== provider.id || typeof model.id !== "string" || !model.id || typeof model.name !== "string" || !model.name || seen.has(model.id)) throw new Error("invalid model");
        seen.add(model.id);
        return { id: model.id, name: model.name, image: "unavailable", video: "unavailable" };
      });
    } catch { failures.push({ id: group.id, name: group.name, message: "模型列表读取失败" }); }
    groups.push(group);
  }));
  const mediaFailures = [], mediaEmpty = [];
  const missing = ["listMediaModels", "generateMedia"].filter(method => typeof llm[method] !== "function");
  for (const group of groups) for (const kind of ["image", "video"]) {
    let reason = null;
    if (missing.length) reason = "interface_missing";
    let models;
    if (!reason) {
      try { models = await llm.listMediaModels(kind, group.id); }
      catch { reason = "call_failed"; }
    }
    if (!reason && (!Array.isArray(models) || models.some(model => !model || model.provider !== group.id || typeof model.id !== "string" || !model.id || model.kind !== kind || !["declared", "unverified"].includes(model.availability)))) reason = "invalid_response";
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
  return async () => {
    try { return new Response(JSON.stringify({ ok: true, catalog: await listHostModelCatalog(llm) }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
    catch { return new Response(JSON.stringify({ ok: false, error: "DSH 模型目录不可用" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
  };
}
