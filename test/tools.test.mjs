import test from "node:test";
import assert from "node:assert/strict";
import { registerShengchengTools } from "../lib/tools.js";
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

test("registerShengchengTools no-ops without tools", () => {
  assert.equal(registerShengchengTools({}), 0);
});
