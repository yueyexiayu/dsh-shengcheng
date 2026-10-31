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
const [{ Context }, { SandboxPolicyService, setSandboxMode }, { SandboxedFileSystem },
  { default: SessionProjectionRegistry }, { Session, SessionId, SESSION_FORMAT_VERSION }] = await Promise.all([
  load("cordis"), load("dsh-sandbox-policy"), load("dsh-fs-sandbox"),
  load("dsh-session-projection"), load("dsh-session"),
]);

export async function officialFixture(t, mode = "read-only") {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-official-fs-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const ctx = new Context();
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: cwd });
  await ctx.plugin(SandboxedFileSystem, { cwd, diffBasisMaxBytes: 1024 });
  const id = SessionId("isolated-media-fixture");
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd });
  const state = { get mode() { return ctx.sandboxPolicy.resolve({ session }).mode; }, set mode(value) { setSandboxMode(session, value); } };
  const controller = new AbortController();
  const exec = { agent: { session }, signal: controller.signal };
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.equal(resolve(root), root);
    assert.ok(root.startsWith(join(tmpdir(), "shengcheng-official-fs-")));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, ctx, exec, controller, state };
}
