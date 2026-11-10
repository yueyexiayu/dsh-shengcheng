window.__ModuleLoader__.load({
  id: "shengcheng",
  factory: function (require) {
    var React = require("react"), h = React.createElement;
    var LOCALE_NS = "shengcheng";
    // Every user-facing string lives here. Chinese is also the fallback used when
    // the locale service is absent, so the panel never shows a raw key.
    var dictionaries = {
      zh: {
        "section.title": "生成默认设置",
        "section.aria": "生成默认设置",
        "note.intro": "从 DSH 已配置的模型中选择图片和视频路线。对话中明确指定的参数优先；模型是否支持生成以 Host 适配器和提供方为准。",
        "note.timeout": "图片和视频每次尝试的总超时均为 600 秒，包含生成、下载和验证；配置兜底时最多尝试两次，最多约 1200 秒。媒体解码另有 60 秒上限。",
        "note.catalog": "模型列表会标注目录发现的能力，并优先排列已声明支持的路线；目录未知或未列出的模型仍可选择，实际支持以提供方调用结果为准。仅会在符合条件时切换至已配置的兜底模型。",
        "note.output": "未设置保存目录时使用会话工作目录；没有工作目录时使用下载文件夹。",
        "note.legacy": "旧版模型设置已保留，请为图片和视频分别选择 DSH 模型。",
        "catalog.partial": "部分聊天模型目录读取失败。",
        "catalog.missingInterface": "当前 Host 缺少媒体生成接口，无法调用。",
        "action.refresh": "刷新模型列表",
        "action.save": "保存设置",
        "action.saving": "保存中…",
        "action.revert": "撤销更改",
        "status.loading": "正在加载设置…",
        "status.saved": "默认设置已保存。",
        "field.imageModel": "默认图片模型",
        "field.videoModel": "默认视频模型",
        "field.imageFallback": "图片兜底模型（可选）",
        "field.videoFallback": "视频兜底模型（可选）",
        "field.imageRatio": "默认图片比例",
        "field.imageQuality": "默认图片质量",
        "field.videoResolution": "默认视频分辨率",
        "field.videoDuration": "默认视频时长（秒，留空为自动）",
        "field.outputDirectory": "默认保存目录",
        "placeholder.outputDirectory": "留空使用会话工作目录",
        "option.auto": "自动",
        "option.notSet": "不设置",
        "option.choose": "请选择 DSH 模型",
        "option.currentUnavailable": "{provider} / {model}（当前不可用）",
        "model.optionLabel": "{group} / {model}（{status}）",
        "capability.declared": "目录已声明支持",
        "capability.unverified": "目录未验证支持",
        "capability.unavailable": "目录未声明支持",
        "capability.unknown": "目录读取失败",
        "capability.unknownFallback": "能力未知",
        "conflict.imageMissing": "图片主模型未选择",
        "conflict.videoMissing": "视频主模型未选择",
        "conflict.imageSame": "图片兜底模型与主模型相同",
        "conflict.videoSame": "视频兜底模型与主模型相同",
        "conflict.separator": "、",
        "error.conflicts": "请修改以下设置：{list}",
        "error.incompatible": "请先修改与所选模型不兼容的默认参数。",
        "error.invalidRoute": "无效的模型路线",
        "error.read": "无法读取数据（HTTP {status}）",
        "error.request": "请求失败（HTTP {status}）",
        "error.settings_too_large": "设置内容过大，请减少内容后重试。",
        "error.invalid_json": "请求体不是有效 JSON，请刷新页面后重试。",
        "error.invalid_request": "无效的设置请求，请刷新页面后重试。",
        "error.settings_conflict": "设置已被其他窗口或 Host 修改，请重新加载后再保存。",
        "error.catalog_unavailable": "DSH 模型目录不可用，请稍后刷新模型列表。",
        "error.catalog_aborted": "模型目录请求已取消。",
        "error.settings_not_object": "设置必须是对象。",
        "error.settings_fields_invalid": "设置字段不完整或包含未知字段，请刷新页面后重试。",
        "error.model_route_invalid": "模型路线须包含有效提供方和模型 ID。",
        "error.media_parameter_invalid": "默认媒体参数无效，请重新选择。",
        "error.video_duration_invalid": "默认视频时长必须为 1–{max} 秒或留空。",
        "error.output_directory_invalid": "默认保存目录无效。",
        "error.legacy_snapshot_invalid": "旧设置快照无效，请刷新页面后重试。",
        "error.legacy_snapshot_locked": "旧设置快照不能在设置页面修改。",
        "error.legacy_settings_invalid": "旧设置字段不完整或无效，已保留原文件；请手动检查设置文件。",
        "error.legacy_settings_unsupported": "旧设置参数无效，已保留原文件；请手动检查设置文件。",
        "error.image_fallback_requires_primary": "图片兜底模型必须先选择主模型。",
        "error.video_fallback_requires_primary": "视频兜底模型必须先选择主模型。",
        "error.image_fallback_same_as_primary": "图片兜底模型不能与主模型相同。",
        "error.video_fallback_same_as_primary": "视频兜底模型不能与主模型相同。",
        "error.settings_io_failed": "设置读取或保存失败，请检查 DSH 存储目录权限。"
      },
      en: {
        "section.title": "Generation defaults",
        "section.aria": "Generation defaults",
        "note.intro": "Choose image and video routes from the models configured in DSH. Parameters given explicitly in a conversation win; whether a model can really generate is decided by the Host adapter and the provider.",
        "note.timeout": "Each image or video attempt times out after 600 seconds, including generation, download and validation. With a fallback configured, at most two attempts run: about 1200 seconds. Media decoding has its own 60-second limit.",
        "note.catalog": "The list marks the capabilities the catalog discovered and puts declared routes first; models the catalog does not know or list stay selectable, and the provider's actual answer decides support. The fallback runs only when its conditions are met.",
        "note.output": "Without an output directory the session working directory is used; with no working directory, the Downloads folder.",
        "note.legacy": "Legacy model settings are preserved; choose a DSH model for images and one for video.",
        "catalog.partial": "Some chat model catalogs could not be read.",
        "catalog.missingInterface": "This Host has no media generation interface, so generation cannot run.",
        "action.refresh": "Refresh model list",
        "action.save": "Save settings",
        "action.saving": "Saving…",
        "action.revert": "Revert changes",
        "status.loading": "Loading settings…",
        "status.saved": "Default settings saved.",
        "field.imageModel": "Default image model",
        "field.videoModel": "Default video model",
        "field.imageFallback": "Image fallback model (optional)",
        "field.videoFallback": "Video fallback model (optional)",
        "field.imageRatio": "Default image aspect ratio",
        "field.imageQuality": "Default image quality",
        "field.videoResolution": "Default video resolution",
        "field.videoDuration": "Default video duration (seconds, empty means automatic)",
        "field.outputDirectory": "Default output directory",
        "placeholder.outputDirectory": "Leave empty to use the session working directory",
        "option.auto": "Automatic",
        "option.notSet": "Not set",
        "option.choose": "Choose a DSH model",
        "option.currentUnavailable": "{provider} / {model} (currently unavailable)",
        "model.optionLabel": "{group} / {model} ({status})",
        "capability.declared": "Declared by the catalog",
        "capability.unverified": "Not verified by the catalog",
        "capability.unavailable": "Not declared by the catalog",
        "capability.unknown": "Catalog read failed",
        "capability.unknownFallback": "Capability unknown",
        "conflict.imageMissing": "The image fallback needs an image primary model",
        "conflict.videoMissing": "The video fallback needs a video primary model",
        "conflict.imageSame": "The image fallback model must differ from the image primary model",
        "conflict.videoSame": "The video fallback model must differ from the video primary model",
        "conflict.separator": "; ",
        "error.conflicts": "Fix these settings first: {list}",
        "error.incompatible": "Change the defaults the selected models do not support first.",
        "error.invalidRoute": "Invalid model route",
        "error.read": "Could not read the response (HTTP {status})",
        "error.request": "Request failed (HTTP {status})",
        "error.settings_too_large": "The settings payload is too large. Reduce it and try again.",
        "error.invalid_json": "The request body is not valid JSON. Reload the page and try again.",
        "error.invalid_request": "Invalid settings request. Reload the page and try again.",
        "error.settings_conflict": "Another window or the Host changed the settings. Reload before saving again.",
        "error.catalog_unavailable": "The DSH model catalog is unavailable. Refresh the model list later.",
        "error.catalog_aborted": "The model catalog request was cancelled.",
        "error.settings_not_object": "Settings must be an object.",
        "error.settings_fields_invalid": "The settings are incomplete or contain unknown fields. Reload the page and try again.",
        "error.model_route_invalid": "A model route needs a valid provider and model ID.",
        "error.media_parameter_invalid": "A default media parameter is invalid; choose it again.",
        "error.video_duration_invalid": "The default video duration must be 1–{max} seconds, or left empty.",
        "error.output_directory_invalid": "The default output directory is invalid.",
        "error.legacy_snapshot_invalid": "The legacy settings snapshot is invalid. Reload the page and try again.",
        "error.legacy_snapshot_locked": "The legacy settings snapshot cannot be changed from the settings page.",
        "error.legacy_settings_invalid": "The legacy settings are incomplete or invalid; the file was kept. Check it by hand.",
        "error.legacy_settings_unsupported": "The legacy settings hold unsupported values; the file was kept. Check it by hand.",
        "error.image_fallback_requires_primary": "Choose an image primary model before an image fallback model.",
        "error.video_fallback_requires_primary": "Choose a video primary model before a video fallback model.",
        "error.image_fallback_same_as_primary": "The image fallback model must differ from the image primary model.",
        "error.video_fallback_same_as_primary": "The video fallback model must differ from the video primary model.",
        "error.settings_io_failed": "Reading or saving the settings failed. Check the permissions of the DSH storage directory."
      }
    };
    function interpolate(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) { return name in params ? String(params[name]) : match; });
    }
    function fallbackTranslate(key, params) {
      var template = dictionaries.zh[key];
      return interpolate(template === undefined ? key : template, params);
    }
    // Host responses carry a stable `code` next to the human message; known codes
    // get a translated sentence, everything else keeps the Host text.
    function failureText(body, status, t) {
      if (body && typeof body.code === "string") {
        var key = "error." + body.code;
        var text = t(key, body.params && typeof body.params === "object" ? body.params : undefined);
        if (text !== key) return text;
      }
      if (body && body.error) return String(body.error.message || body.error);
      return t("error.request", { status: status });
    }
    function createSettings(t) {
      return function Settings() {
        async function request(url, options) {
          var response = await fetch(url, options), body;
          try { body = await response.json(); } catch (_) { throw new Error(t("error.read", { status: response.status })); }
          if (!response.ok || !body || body.ok !== true) throw new Error(failureText(body, response.status, t));
          return body;
        }
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
          if (conflicts.length) { setError(t("error.incompatible")); return; }
          setPending(true); setMessage(""); setError("");
          try { var body = await request("/api/shengcheng/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: draft, revision: revision }) }); setSaved(body.settings); setDraft(body.settings); setRevision(body.revision); setMessage(t("status.saved")); }
          catch (err) { setError(err.message); } finally { setPending(false); }
        }
        function select(label, key, values) { var options = [["auto", t("option.auto")]].concat(values.filter(function (value) { return value !== "auto"; }).map(function (value) { return [value, value]; })); if (!options.some(function (option) { return option[0] === draft[key]; })) options.push([draft[key], draft[key]]); return h("label", { className: "shengcheng-settings-field" }, label, h("select", { value: draft[key], disabled: pending, onChange: function (event) { edit(key, event.target.value); } }, options.map(function (option) { return h("option", { value: option[0], key: option[0] }, option[1]); }))); }
        function routeKey(route) { return route ? JSON.stringify([route.provider, route.model]) : ""; }
        function modelSelect(label, key, kind, optional) {
          var options = [], entries = [], selected = routeKey(draft[key]), known = false, availabilityOrder = { declared: 0, unverified: 1, unavailable: 2, unknown: 3 };
          function availability(model) { var value = model && model[kind], labels = { declared: "capability.declared", unverified: "capability.unverified", unavailable: "capability.unavailable", unknown: "capability.unknown" }; return [labels[value] ? t(labels[value]) : t("capability.unknownFallback"), availabilityOrder[value] ?? 3]; }
          if (catalog && Array.isArray(catalog.groups)) catalog.groups.forEach(function (group) {
            (group.models || []).forEach(function (model) {
              var value = JSON.stringify([group.id, model.id]), status = availability(model);
              if (value === selected) known = true;
              entries.push({ group: group, model: model, value: value, status: status });
            });
          });
          entries.sort(function (a, b) { return a.status[1] - b.status[1] || (a.group.name || a.group.id).localeCompare(b.group.name || b.group.id) || a.model.name.localeCompare(b.model.name); }).forEach(function (entry) { options.push(h("option", { key: entry.value, value: entry.value }, t("model.optionLabel", { group: entry.group.name || entry.group.id, model: entry.model.name, status: entry.status[0] }))); });
          return h("label", { className: "shengcheng-settings-field" }, label,
            h("select", { value: selected, disabled: pending || !catalog, onChange: function (event) { var value = event.target.value; if (!value) return edit(key, null); try { var pair = JSON.parse(value); edit(key, { provider: pair[0], model: pair[1] }); } catch (_) { setError(t("error.invalidRoute")); } } },
              h("option", { value: "" }, optional ? t("option.notSet") : t("option.choose")), selected && !known ? h("option", { value: selected, disabled: true }, t("option.currentUnavailable", { provider: draft[key].provider, model: draft[key].model })) : null, options));
        }
        function parameters(route, kind) { if (!route || !catalog || !Array.isArray(catalog.groups)) return null; var group = catalog.groups.find(function (item) { return item.id === route.provider; }); var model = group && group.models.find(function (item) { return item.id === route.model; }); return model && model[kind + "Parameters"] || null; }
        var dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
        function choices(common, primary, fallback, key) { var result = common.slice(); [primary, fallback].forEach(function (item) { var values = item && item[key]; if (Array.isArray(values)) values.forEach(function (value) { if (typeof value === "string" && value && !result.includes(value)) result.push(value); }); }); return result; }
        var imagePrimary = draft && parameters(draft.imageRoute, "image"), imageFallback = draft && parameters(draft.imageFallbackRoute, "image"), videoPrimary = draft && parameters(draft.videoRoute, "video"), videoFallback = draft && parameters(draft.videoFallbackRoute, "video"), conflicts = [];
        var imageRatios = choices(["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"], imagePrimary, imageFallback, "aspectRatios"), imageQualities = choices(["low", "medium", "high"], imagePrimary, imageFallback, "qualities"), videoResolutions = choices(["480p", "720p", "1080p"], videoPrimary, videoFallback, "resolutions");
        if (draft) ["image", "video"].forEach(function (kind) { var main = draft[kind + "Route"], fallback = draft[kind + "FallbackRoute"]; if (fallback && !main) conflicts.push(t(kind === "image" ? "conflict.imageMissing" : "conflict.videoMissing")); if (fallback && main && routeKey(main) === routeKey(fallback)) conflicts.push(t(kind === "image" ? "conflict.imageSame" : "conflict.videoSame")); });
        return h("section", { className: "shengcheng-settings", "aria-label": t("section.aria") },
          h("style", null, ".shengcheng-settings{margin:18px 0;font:inherit;color:inherit}.shengcheng-settings h3{font-size:16px;font-weight:650;letter-spacing:-.02em;margin:0 0 10px}.shengcheng-settings p{margin:9px 0;line-height:1.5}.shengcheng-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:16px 0}.shengcheng-settings-field{display:flex;flex-direction:column;gap:7px}.shengcheng-settings select,.shengcheng-settings input{box-sizing:border-box;width:100%;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:10px;padding:8px 11px;transition:border-color .15s,box-shadow .15s}.shengcheng-settings select:focus-visible,.shengcheng-settings input:focus-visible{outline:0;border-color:var(--dsw-alias-state-business-primary,#007aff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#007aff) 22%,transparent)}.shengcheng-settings button{font:inherit;font-weight:500;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:10px;padding:8px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06);cursor:pointer}.shengcheng-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eceff4)}.shengcheng-settings button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#007aff);outline-offset:2px}.shengcheng-settings button:active:not(:disabled){transform:translateY(1px)}.shengcheng-settings button:disabled{opacity:.5;cursor:default}.shengcheng-settings-error{color:var(--dsw-alias-danger-fg,#c23b3b)}.shengcheng-settings-note{color:var(--dsw-alias-label-secondary,#757b85)}"),
          h("h3", null, t("section.title")),
          h("p", { className: "shengcheng-settings-note" }, t("note.intro")),
          h("p", { className: "shengcheng-settings-note" }, t("note.timeout")),
          error ? h("p", { role: "alert", className: "shengcheng-settings-error" }, error) : null,
          message ? h("p", { role: "status" }, message) : null,
          catalogError ? h("p", { role: "alert", className: "shengcheng-settings-error" }, catalogError) : null,
          catalog && catalog.failures.length ? h("p", { role: "alert", className: "shengcheng-settings-error" }, t("catalog.partial")) : null,
          catalog && catalog.mediaFailures.some(function (failure) { return failure.reason === "interface_missing"; }) ? h("p", { role: "alert", className: "shengcheng-settings-error" }, t("catalog.missingInterface")) : null,
          h("button", { type: "button", disabled: pending, onClick: function () { setGeneration(function (n) { return n + 1; }); } }, t("action.refresh")),
          !draft ? (!error ? h("p", { role: "status" }, t("status.loading")) : null) : h("form", { onSubmit: save },
            h("div", { className: "shengcheng-settings-grid" },
              modelSelect(t("field.imageModel"), "imageRoute", "image"), modelSelect(t("field.videoModel"), "videoRoute", "video"),
              modelSelect(t("field.imageFallback"), "imageFallbackRoute", "image", true), modelSelect(t("field.videoFallback"), "videoFallbackRoute", "video", true),
              select(t("field.imageRatio"), "imageAspectRatio", imageRatios), select(t("field.imageQuality"), "imageQuality", imageQualities),
              select(t("field.videoResolution"), "videoResolution", videoResolutions),
              h("label", { className: "shengcheng-settings-field" }, t("field.videoDuration"), h("input", { type: "number", min: 1, max: 30, step: 1, value: draft.videoDuration === null ? "" : draft.videoDuration, disabled: pending, onChange: function (event) { edit("videoDuration", event.target.value === "" ? null : Number(event.target.value)); } })),
              h("label", { className: "shengcheng-settings-field" }, t("field.outputDirectory"), h("input", { type: "text", value: draft.outputDirectory, disabled: pending, placeholder: t("placeholder.outputDirectory"), onChange: function (event) { edit("outputDirectory", event.target.value); } }))),
            h("p", { className: "shengcheng-settings-note" }, t("note.catalog")),
            conflicts.length ? h("p", { role: "alert", className: "shengcheng-settings-error" }, t("error.conflicts", { list: conflicts.join(t("conflict.separator")) })) : null,
            draft.legacySettings ? h("p", { className: "shengcheng-settings-note" }, t("note.legacy")) : null,
            h("p", { className: "shengcheng-settings-note" }, t("note.output")),
            h("button", { type: "submit", disabled: pending || !dirty || !!conflicts.length }, pending ? t("action.saving") : t("action.save")), " ", h("button", { type: "button", disabled: pending || !dirty, onClick: function () { setDraft(saved); setError(""); setMessage(""); } }, t("action.revert"))));
      };
    }
    function apply(ctx) {
      var locale = ctx && ctx.locale;
      // Bind first: translation resolves against the active locale at render
      // time, so registration order does not matter. A key the service cannot
      // resolve yet still renders Chinese instead of leaking the raw key.
      var bound = locale && typeof locale.bind === "function" ? locale.bind(LOCALE_NS) : null;
      function t(key, params) {
        if (!bound) return fallbackTranslate(key, params);
        var text = bound(key, params);
        return text === key ? fallbackTranslate(key, params) : text;
      }
      function install() {
        if (!locale || typeof locale.register !== "function") return function () {};
        try {
          var off = locale.register(LOCALE_NS, dictionaries);
          return typeof off === "function" ? off : function () {};
        } catch (_) { return function () {}; }
      }
      if (typeof ctx.effect === "function") ctx.effect(install, "shengcheng.locale");
      else install();
      var Settings = createSettings(t);
      ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register({ name: "plugins.bundle.config", key: "shengcheng" }, Settings); });
    }
    return { inject: ["slots", "locale"], apply: apply };
  }
});
