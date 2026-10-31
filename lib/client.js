window.__ModuleLoader__.load({
  id: "shengcheng",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;
    var endpoint = "/api/shengcheng/settings";

    async function request(method, settings, signal) {
      var options = { method: method, signal: signal, cache: "no-store" };
      if (settings) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify({ settings: settings });
      }
      var response = await fetch(endpoint, options);
      var body;
      try { body = await response.json(); } catch (_) { throw new Error("无法读取设置（HTTP " + response.status + "）"); }
      if (!response.ok || !body || body.ok !== true || !body.settings) {
        throw new Error(body && body.error ? String(body.error.message || body.error) : "设置请求失败（HTTP " + response.status + "）");
      }
      return body.settings;
    }

    function Settings() {
      var _draft = React.useState(null), draft = _draft[0], setDraft = _draft[1];
      var _saved = React.useState(null), saved = _saved[0], setSaved = _saved[1];
      var _pending = React.useState(false), pending = _pending[0], setPending = _pending[1];
      var _message = React.useState(""), message = _message[0], setMessage = _message[1];
      var _error = React.useState(""), error = _error[0], setError = _error[1];

      React.useEffect(function () {
        var controller = new AbortController();
        request("GET", null, controller.signal).then(function (settings) {
          if (!controller.signal.aborted) { setSaved(settings); setDraft(settings); }
        }).catch(function (err) { if (!controller.signal.aborted) setError(err.message); });
        return function () { controller.abort(); };
      }, []);

      function edit(key, value) {
        setDraft(function (current) { return Object.assign({}, current, { [key]: value }); });
        setMessage("");
        setError("");
      }
      async function save(event) {
        event.preventDefault();
        if (!draft || pending) return;
        setPending(true); setError(""); setMessage("");
        try { var result = await request("POST", draft); setSaved(result); setDraft(result); setMessage("默认设置已保存。"); }
        catch (err) { setError(err.message); }
        finally { setPending(false); }
      }
      function select(label, key, options) {
        var invalid = !options.some(function (option) { return option[0] === draft[key]; });
        return h("label", { className: "shengcheng-settings-field" }, label,
          h("select", { value: draft[key], disabled: pending, "aria-invalid": invalid || undefined, onChange: function (event) { edit(key, event.target.value); } },
            invalid ? h("option", { value: draft[key], disabled: true }, String(draft[key]) + "（当前提供方不支持）") : null,
            options.map(function (option) { return h("option", { value: option[0], key: option[0] }, option[1]); })));
      }
      var modelIdPattern = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$");
      function modelInput(label, key) {
        return h("label", { className: "shengcheng-settings-field" }, label,
          h("input", { type: "text", required: true, maxLength: 128, value: draft[key], disabled: pending,
            "aria-invalid": !modelIdPattern.test(draft[key]) || undefined,
            onChange: function (event) { edit(key, event.target.value); } }));
      }
      var dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
      var commonRatios = [["auto", "自动"], ["1:1", "1:1"], ["3:2", "3:2"], ["2:3", "2:3"]];
      var ratioOptions = draft && draft.provider === "grok" ? commonRatios.concat(["16:9", "9:16", "4:3", "3:4", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2"].map(function (value) { return [value, value]; })) : commonRatios;
      var qualityOptions = [["auto", "自动"], ["low", "低"], ["medium", "中"]];
      if (draft && draft.provider === "gpt") qualityOptions.push(["high", "高"]);
      var invalidImageOptions = !!draft && (!ratioOptions.some(function (option) { return option[0] === draft.imageAspectRatio; }) || !qualityOptions.some(function (option) { return option[0] === draft.imageQuality; }));
      var invalidModelIds = !!draft && [draft.grokImageModel, draft.gptImageModel, draft.grokVideoModel].some(function (value) { return typeof value !== "string" || !modelIdPattern.test(value); });
      return h("section", { className: "shengcheng-settings", "aria-label": "生成默认设置" },
        h("style", null, ".shengcheng-settings{margin:16px 0;font:inherit;color:inherit}.shengcheng-settings h3{font-size:14px;margin:0 0 8px}.shengcheng-settings p{margin:8px 0}.shengcheng-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}.shengcheng-settings-field{display:flex;flex-direction:column;gap:6px}.shengcheng-settings select,.shengcheng-settings input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:7px 9px}.shengcheng-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:6px 12px;cursor:pointer}.shengcheng-settings button:disabled{opacity:.5;cursor:default}.shengcheng-settings-error{color:var(--dsw-alias-danger-fg,#c23b3b)}.shengcheng-settings-note{color:var(--dsw-alias-label-secondary,#757b85)}"),
        h("h3", null, "生成默认设置"),
        h("p", { className: "shengcheng-settings-note" }, "对话中明确指定的参数优先。视频默认使用 Grok；自动保持原有默认行为。"),
        error ? h("p", { role: "alert", className: "shengcheng-settings-error" }, error) : null,
        message ? h("p", { role: "status" }, message) : null,
        !draft ? (!error ? h("p", { role: "status" }, "正在加载设置…") : null) :
          h("form", { onSubmit: save },
            h("div", { className: "shengcheng-settings-grid" },
              select("默认图片提供方", "provider", [["auto", "自动"], ["grok", "Grok"], ["gpt", "GPT"]]),
              modelInput("Grok 图片模型 ID", "grokImageModel"),
              modelInput("GPT 图片模型 ID", "gptImageModel"),
              modelInput("Grok 视频模型 ID", "grokVideoModel"),
              select("默认图片比例", "imageAspectRatio", ratioOptions),
              select("默认图片质量", "imageQuality", qualityOptions),
              select("默认视频分辨率", "videoResolution", [["480p", "480p"], ["720p", "720p"], ["1080p", "1080p"]]),
              h("label", { className: "shengcheng-settings-field" }, "默认视频时长（秒）", h("input", { type: "number", min: 1, max: 15, step: 1, required: true, value: draft.videoDuration, disabled: pending, onChange: function (event) { edit("videoDuration", event.target.value === "" ? "" : Number(event.target.value)); } })),
              h("label", { className: "shengcheng-settings-field" }, "默认保存目录", h("input", { type: "text", value: draft.outputDirectory, disabled: pending, placeholder: "留空使用会话工作目录", onChange: function (event) { edit("outputDirectory", event.target.value); } }))),
            h("p", { className: "shengcheng-settings-note" }, "模型 ID 会发送至对应账号的现有生成接口；模型是否可用及参数是否受支持由该接口和账号决定。"),
            h("p", { className: "shengcheng-settings-note" }, "未设置保存目录时使用会话工作目录；没有工作目录时使用下载文件夹。"),
            invalidImageOptions ? h("p", { role: "alert", className: "shengcheng-settings-error" }, "图片比例或质量不适用于当前提供方，请调整后保存。") : null,
            invalidModelIds ? h("p", { role: "alert", className: "shengcheng-settings-error" }, "模型 ID 须以字母或数字开头，只能包含字母、数字及 . _ : / -，最多 128 个字符。") : null,
            h("button", { type: "submit", disabled: pending || !dirty || invalidImageOptions || invalidModelIds }, pending ? "保存中…" : "保存设置"), " ",
            h("button", { type: "button", disabled: pending || !dirty, onClick: function () { setDraft(saved); setError(""); setMessage(""); } }, "撤销更改")));
    }

    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({ name: "plugins.bundle.config", key: "shengcheng" }, Settings);
      });
    }
    return { inject: ["slots"], apply: apply };
  }
});
