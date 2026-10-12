import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Read-only reference to the extracted installation. Missing references fail,
// not skip; no running Host, credentials or official files are modified.
if (!process.env.DSH_OFFICIAL_ROOT) throw new Error("Set DSH_OFFICIAL_ROOT to an extracted official DSH runtime before running filesystem integration tests.");
const official = resolve(process.env.DSH_OFFICIAL_ROOT);
const load = name => import(pathToFileURL(join(official, "node_modules/@deepseek-ai", name, "lib/index.js")));
const [{ Context }, { SandboxPolicyService }, { SandboxedFileSystem }] = await Promise.all([
  load("cordis"), load("dsh-sandbox-policy"), load("dsh-fs-sandbox"),
]);

export async function officialFixture(t, mode = "read-only") {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-official-fs-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const state = { mode };
  const ctx = new Context();
  ctx.provide("sessionProjections", { register() {}, stateOf() { return state.mode; } });
  new SandboxPolicyService(ctx, { mode, workspaceRoot: cwd });
  new SandboxedFileSystem(ctx, { cwd, diffBasisMaxBytes: 1024 });
  const controller = new AbortController();
  const exec = { agent: { session: { id: "isolated-media-fixture", header: { cwd } } }, signal: controller.signal };
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.equal(resolve(root), root);
    assert.ok(root.startsWith(join(tmpdir(), "shengcheng-official-fs-")));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, ctx, exec, controller, state };
}
