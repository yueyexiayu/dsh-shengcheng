import test from "node:test";
import assert from "node:assert/strict";
import { currentProvider, registerShengchengTools } from "../lib/tools.js";
import { apply } from "../lib/index.js";

test("apply registers one tool", () => {
  const names = [];
  const ctx = {
    tools: {
      register(tool) {
        names.push(tool.name);
        assert.equal(typeof tool.execute, "function");
        assert.equal(typeof tool.output.render, "function");
        assert.equal(tool.parameters.properties.kind.type, "string");
      },
    },
  };
  apply(ctx);
  assert.deepEqual(names, ["shengcheng"]);
});

test("registerShengchengTools fails visibly without its injected service", () => {
  assert.throws(() => registerShengchengTools({}), TypeError);
});

test("auto provider uses the active request header before global defaults", () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: "xai" }) }) };
  const exec = { agent: { session: { header: { config: { provider: "old-immutable-provider" } }, requestHeader: () => ({ config: { provider: "openai-codex" } }) } } };
  assert.equal(currentProvider(ctx, exec), "openai-codex");
});

test("provider fallback reads current settings through describe", () => {
  const ctx = { get: name => name === "settings" ? {
    describe: options => {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: "agent-default-model", value: { provider: "xai" } }];
    },
  } : undefined };
  assert.equal(currentProvider(ctx), "xai");
});
