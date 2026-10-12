import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { referencePath, prepareOutput } from "../lib/storage.js";
import { officialFixture } from "./official-fixture.mjs";

test("official filesystem reads references in read-only and writes remain fenced", async t => {
  const f = await officialFixture(t);
  const outside = join(f.root, "outside.png");
  await writeFile(outside, "reference fixture");
  await symlink(outside, join(f.cwd, "alias.png"));
  const expected = await f.ctx.fs.resolve(outside);
  assert.equal(await referencePath(f.ctx, f.exec, outside, f.cwd), f.ctx.fs.processPath(expected));
  assert.equal(await referencePath(f.ctx, f.exec, "alias.png", f.cwd), f.ctx.fs.processPath(expected));
  assert.equal(await referencePath(f.ctx, f.exec, "../outside.png", f.cwd), f.ctx.fs.processPath(expected));
  await assert.rejects(prepareOutput(f.ctx, f.exec, "output.png", { cwd: f.cwd, kind: "image", provider: "grok", ext: "png" }), { code: "FS_SANDBOX_DENIED" });
  assert.deepEqual(await readdir(f.cwd), ["alias.png"]);
});

test("official checkedTarget enforces workspace denial; temp and full-access saves are truthful", async t => {
  const f = await officialFixture(t, "workspace-write");
  const opts = { cwd: f.cwd, kind: "image", provider: "grok", ext: "png" };
  // Official workspace-write includes all platform temporary roots, so a fake
  // stricter /tmp boundary would not model its real contract.
  await assert.rejects(prepareOutput(f.ctx, f.exec, "/Users/Shared/shengcheng-denied-fixture/output.png", opts), { code: "FS_SANDBOX_DENIED" });
  for (const mode of ["workspace-write", "danger-full-access"]) {
    f.state.mode = mode;
    const output = await prepareOutput(f.ctx, f.exec, join(f.root, mode, "output.png"), opts);
    try { assert.equal(await readFile(await output.save(Buffer.from(mode), "png"), "utf8"), mode); }
    finally { await output.dispose(); }
  }
  const output = await prepareOutput(f.ctx, f.exec, "changed.png", opts);
  f.state.mode = "read-only";
  await assert.rejects(output.save(Buffer.from("fixture"), "png"), { code: "FS_SANDBOX_DENIED" });
  await output.dispose();
  assert.deepEqual(await readdir(f.cwd), []);
});
