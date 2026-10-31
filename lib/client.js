window.__ModuleLoader__.load({
  id: "shengcheng",
  factory: function (require) {
    var React = require("react"), h = React.createElement;
    async function request(url, options) {
      var response = await fetch(url, options), body;
      try { body = await response.json(); } catch (_) { throw new Error("无法读取数据（HTTP " + response.status + "）"); }
      if (!response.ok || !body || body.ok !== true) throw new Error(body && body.error ? String(body.error.message || body.error) : "请求失败（HTTP " + response.status + "）");
      return body;
    }
    function Settings() {
      var state = React.useState(null), draft = state[0], setDraft = state[1];
      var s = React.useState(null), saved = s[0], setSaved = s[1];
      var rev = React.useState(null), revision = rev[0], setRevision = rev[1];
      var c = React.useState(null), catalog = c[0], setCatalog = c[1];
      var p = React.useState(false), pending = p[0], setPending = p[1];
      var m = React.useState(""), message = m[0], setMessage = m[1];
      var e = React.useState(""), error = e[0], setError = e[1];
      var ce = React.useState(""), catalogError = ce[0], setCatalogError = ce[1];
      var refresh = React.useState(0), generation = refresh[0], setGeneration = refresh[1];
      React.useEffect(function () {
        var controller = new AbortController();
        request("/api/shengcheng/settings", { signal: controller.signal, cache: "no-store" }).then(function (body) { if (!controller.signal.aborted) { setSaved(body.settings); setDraft(body.settings); setRevision(body.revision); } }).catch(function (err) { if (!controller.signal.aborted) setError(err.message); });
        return function () { controller.abort(); };
      }, []);
      React.useEffect(function () {
        var controller = new AbortController(); setCatalogError("");
        request("/api/shengcheng/models", { signal: controller.signal, cache: "no-store" }).then(function (body) { if (!controller.signal.aborted) setCatalog(body.catalog); }).catch(function (err) { if (!controller.signal.aborted) { setCatalog(null); setCatalogError(err.message); } });
        return function () { controller.abort(); };
      }, [generation]);
      function edit(key, value) { setDraft(function (current) { return Object.assign({}, current, { [key]: value }); }); setMessage(""); setError(""); }
      async function save(event) {
        event.preventDefault(); if (!draft || pending) return;
        if (conflicts.length) { setError("请先修改与所选模型不兼容的默认参数。"); return; }
        setPending(true); setMessage(""); setError("");
        try { var body = await request("/api/shengcheng/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: draft, revision: revision }) }); setSaved(body.settings); setDraft(body.settings); setRevision(body.revision); setMessage("默认设置已保存。"); }
        catch (err) { setError(err.message); } finally { setPending(false); }
      }
      function select(label, key, values) { var options = [["auto", "自动"]].concat((values || []).filter(function (value) { return value !== "auto"; }).map(function (value) { return [value, value]; })); if (!options.some(function (option) { return option[0] === draft[key]; })) options.push([draft[key], draft[key] + "（不兼容，请修改）", true]); return h("label", { className: "shengcheng-settings-field" }, label, h("select", { value: draft[key], disabled: pending, onChange: function (event) { edit(key, event.target.value); } }, options.map(function (option) { return h("option", { value: option[0], key: option[0], disabled: option[2] }, option[1]); }))); }
      function routeKey(route) { return route ? JSON.stringify([route.provider, route.model]) : ""; }
      function modelSelect(label, key, kind, optional) {
        var options = [], selected = routeKey(draft[key]), known = false;
        if (catalog && Array.isArray(catalog.groups)) catalog.groups.forEach(function (group) {
          (group.models || []).forEach(function (model) {
            var value = JSON.stringify([group.id, model.id]), status = model[kind];
            if (value === selected) known = true;
            var note = status === "declared" ? "" : status === "unverified" ? "（支持待确认）" : status === "unknown" ? "（能力目录不可用）" : "（当前 Host 无适配器）";
            options.push(h("option", { key: value, value: value, disabled: status !== "declared" && status !== "unverified" }, (group.name || group.id) + " / " + model.name + note));
          });
        });
        return h("label", { className: "shengcheng-settings-field" }, label,
          h("select", { value: selected, disabled: pending || !catalog, onChange: function (event) { var value = event.target.value; if (!value) return edit(key, null); try { var pair = JSON.parse(value); edit(key, { provider: pair[0], model: pair[1] }); } catch (_) { setError("无效的模型路线"); } } },
            h("option", { value: "" }, optional ? "不设置" : "请选择 DSH 模型"), selected && !known ? h("option", { value: selected, disabled: true }, draft[key].provider + " / " + draft[key].model + "（当前不可用）") : null, options));
      }
      function parameters(route, kind) { if (!route || !catalog || !Array.isArray(catalog.groups)) return null; var group = catalog.groups.find(function (item) { return item.id === route.provider; }); var model = group && group.models.find(function (item) { return item.id === route.model; }); return model && model[kind + "Parameters"] || null; }
      var dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
      function intersection(primary, fallback, route) { if (!route) return primary; if (!primary || !fallback) return null; var result = {}; ["aspectRatios", "qualities", "resolutions"].forEach(function (key) { if (Array.isArray(primary[key]) && Array.isArray(fallback[key])) result[key] = primary[key].filter(function (value) { return fallback[key].includes(value); }); }); if (primary.duration && fallback.duration) result.duration = { min: Math.max(primary.duration.min, fallback.duration.min), max: Math.min(primary.duration.max, fallback.duration.max) }; return result; }
      var imageParameters = draft && intersection(parameters(draft.imageRoute, "image"), parameters(draft.imageFallbackRoute, "image"), draft.imageFallbackRoute), videoParameters = draft && intersection(parameters(draft.videoRoute, "video"), parameters(draft.videoFallbackRoute, "video"), draft.videoFallbackRoute), conflicts = [];
      function check(route, params, field, value, allowed) { if (route && value !== "auto" && value !== null && (!params || !Array.isArray(allowed) || !allowed.includes(value))) conflicts.push(field); }
      if (draft) { check(draft.imageRoute, imageParameters, "图片比例", draft.imageAspectRatio, imageParameters && imageParameters.aspectRatios); check(draft.imageRoute, imageParameters, "图片质量", draft.imageQuality, imageParameters && imageParameters.qualities); check(draft.videoRoute, videoParameters, "视频分辨率", draft.videoResolution, videoParameters && videoParameters.resolutions); if (draft.videoRoute && draft.videoDuration !== null && (!videoParameters || !videoParameters.duration || !Number.isInteger(draft.videoDuration) || draft.videoDuration < videoParameters.duration.min || draft.videoDuration > videoParameters.duration.max)) conflicts.push("视频时长"); }
      if (draft) ["image", "video"].forEach(function (kind) { var main = draft[kind + "Route"], fallback = draft[kind + "FallbackRoute"]; if (fallback && !main) conflicts.push((kind === "image" ? "图片" : "视频") + "主模型未选择"); if (fallback && main && routeKey(main) === routeKey(fallback)) conflicts.push((kind === "image" ? "图片" : "视频") + "兜底模型与主模型相同"); });
      return h("section", { className: "shengcheng-settings", "aria-label": "生成默认设置" },
        h("style", null, ".shengcheng-settings{margin:16px 0;font:inherit;color:inherit}.shengcheng-settings h3{font-size:14px;margin:0 0 8px}.shengcheng-settings p{margin:8px 0}.shengcheng-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}.shengcheng-settings-field{display:flex;flex-direction:column;gap:6px}.shengcheng-settings select,.shengcheng-settings input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:7px 9px}.shengcheng-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:6px 12px;cursor:pointer}.shengcheng-settings button:disabled{opacity:.5;cursor:default}.shengcheng-settings-error{color:var(--dsw-alias-danger-fg,#c23b3b)}.shengcheng-settings-note{color:var(--dsw-alias-label-secondary,#757b85)}"),
        h("h3", null, "生成默认设置"),
        h("p", { className: "shengcheng-settings-note" }, "从 DSH 已配置的模型中选择图片和视频路线。对话中明确指定的参数优先；模型是否支持生成以 Host 适配器和提供方为准。"),
        h("p", { className: "shengcheng-settings-note" }, "图片和视频每次尝试的总超时均为 600 秒，包含生成、下载和验证；配置兜底时最多尝试两次，最多约 1200 秒。媒体解码另有 60 秒上限。"),
        error ? h("p", { role: "alert", className: "shengcheng-settings-error" }, error) : null,
        message ? h("p", { role: "status" }, message) : null,
        catalogError ? h("p", { role: "alert", className: "shengcheng-settings-error" }, catalogError) : null,
        catalog && (catalog.failures.length || catalog.mediaFailures.length) ? h("p", { role: "alert", className: "shengcheng-settings-error" }, "部分模型或媒体能力目录读取失败，请刷新后重试。") : null,
        h("button", { type: "button", disabled: pending, onClick: function () { setGeneration(function (n) { return n + 1; }); } }, "刷新模型列表"),
        !draft ? (!error ? h("p", { role: "status" }, "正在加载设置…") : null) : h("form", { onSubmit: save },
          h("div", { className: "shengcheng-settings-grid" },
            modelSelect("默认图片模型", "imageRoute", "image"), modelSelect("默认视频模型", "videoRoute", "video"),
            modelSelect("图片兜底模型（可选）", "imageFallbackRoute", "image", true), modelSelect("视频兜底模型（可选）", "videoFallbackRoute", "video", true),
            select("默认图片比例", "imageAspectRatio", imageParameters && imageParameters.aspectRatios), select("默认图片质量", "imageQuality", imageParameters && imageParameters.qualities),
            select("默认视频分辨率", "videoResolution", videoParameters && videoParameters.resolutions),
            h("label", { className: "shengcheng-settings-field" }, "默认视频时长（秒，留空为自动）", h("input", { type: "number", min: videoParameters && videoParameters.duration ? videoParameters.duration.min : 1, max: videoParameters && videoParameters.duration ? videoParameters.duration.max : 3600, step: 1, value: draft.videoDuration === null ? "" : draft.videoDuration, disabled: pending, onChange: function (event) { edit("videoDuration", event.target.value === "" ? null : Number(event.target.value)); } })),
            h("label", { className: "shengcheng-settings-field" }, "默认保存目录", h("input", { type: "text", value: draft.outputDirectory, disabled: pending, placeholder: "留空使用会话工作目录", onChange: function (event) { edit("outputDirectory", event.target.value); } }))),
          h("p", { className: "shengcheng-settings-note" }, "标注“支持待确认”的模型可以尝试，最终结果由提供方返回；仅会在符合条件时切换至已配置的兜底模型。"),
          conflicts.length ? h("p", { role: "alert", className: "shengcheng-settings-error" }, "所选路线不支持或无法确认以下默认参数，请修改后保存：" + conflicts.join("、")) : null,
          draft.legacySettings ? h("p", { className: "shengcheng-settings-note" }, "旧版模型设置已保留，请为图片和视频分别选择 DSH 模型。") : null,
          h("p", { className: "shengcheng-settings-note" }, "未设置保存目录时使用会话工作目录；没有工作目录时使用下载文件夹。"),
          h("button", { type: "submit", disabled: pending || !dirty || !!conflicts.length }, pending ? "保存中…" : "保存设置"), " ", h("button", { type: "button", disabled: pending || !dirty, onClick: function () { setDraft(saved); setError(""); setMessage(""); } }, "撤销更改")));
    }
    function apply(ctx) { ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register({ name: "plugins.bundle.config", key: "shengcheng" }, Settings); }); }
    return { inject: ["slots"], apply: apply };
  }
});
