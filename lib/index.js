import { PLUGIN_ID } from "./parse.js";
import { registerShengchengTools } from "./tools.js";
import { loadSettings, settingsHandler } from "./settings.js";
import { modelCatalogHandler } from "./model-catalog.js";

export const name = PLUGIN_ID;
export const inject = ["llm", "tools", "fs", "sandboxPolicy", "connection"];

export function apply(ctx) {
  registerShengchengTools(ctx, loadSettings);
  ctx.connection.fetch.register({ path: "/api/shengcheng/settings", methods: ["GET", "POST"], requestBody: "buffered", fetch: settingsHandler() });
  ctx.connection.fetch.register({ path: "/api/shengcheng/models", methods: ["GET"], requestBody: "buffered", fetch: modelCatalogHandler(ctx.llm) });
}
