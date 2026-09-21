import { PLUGIN_ID } from "./parse.js";
import { registerShengchengTools } from "./tools.js";

export const name = PLUGIN_ID;
export const inject = ["credentials", "tools"];

export function apply(ctx) {
  registerShengchengTools(ctx);
}
