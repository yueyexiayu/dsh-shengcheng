import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoJobStore, videoJobRecordId } from "../lib/jobs.js";

function record(overrides = {}) {
  const identity = { provider: "provider-a", model: "video-model", jobId: "job-1", routeFingerprint: "a".repeat(64), ...overrides };
  return {
    version: 1,
    recordId: videoJobRecordId(identity),
    provider: identity.provider,
    model: identity.model,
    jobId: identity.jobId,
    routeFingerprint: identity.routeFingerprint,
    acceptedAt: "2026-11-11T00:00:00.000Z",
    state: "accepted",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
}

test("saves a stable private record and updates terminal state", async t => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-jobs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse("2026-11-11T00:00:00.000Z");
  const store = new VideoJobStore({ root, now: () => new Date(tick += 1_000) });
  const first = await store.save(record());
  assert.equal(first.recordId, videoJobRecordId(first));
  assert.equal((await stat(store.path(first.recordId))).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(first.recordId), first);
  const completed = await store.update(first.recordId, { state: "completed" });
  assert.equal(completed.state, "completed");
  assert.ok(Date.parse(completed.updatedAt) > Date.parse(completed.acceptedAt));
  assert.deepEqual((await store.list()).jobs, [completed]);
  assert.equal(await store.remove(first.recordId), true);
  assert.deepEqual(await readdir(root), []);
});

test("rejects forged identities and path traversal", async t => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-jobs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new VideoJobStore({ root });
  assert.throws(() => store.path("../outside"), /记录 ID 无效/);
  await assert.rejects(store.save({ ...record(), model: "other" }), /ID 不匹配/);
  await assert.rejects(store.load("../outside"), /记录 ID 无效/);
});

test("bounds the directory so accepted jobs cannot grow it without limit", async t => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-jobs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new VideoJobStore({ root });
  const ids = [];
  for (let index = 0; index < 205; index++) {
    const saved = await store.save(record({ jobId: `job-${index}` }));
    ids.push(saved.recordId);
  }
  const files = (await readdir(root)).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 200);
  // The oldest accepted job is dropped; the newest 200 survive.
  await assert.rejects(store.load(ids[0]), /ENOENT|记录/);
  assert.equal((await store.load(ids.at(-1))).jobId, "job-204");
  // A completed record is evicted before an accepted one.
  let tick = Date.parse("2026-11-11T06:00:00.000Z");
  const fresh = new VideoJobStore({ root, now: () => new Date(tick += 1_000) });
  const acceptedRecord = (jobId) => { const { updatedAt, ...rest } = record({ jobId }); return { ...rest, acceptedAt: "2026-11-11T05:59:00.000Z" }; };
  const accepted = await fresh.save(acceptedRecord("still-running"));
  for (let index = 0; index < 4; index++) await fresh.update(ids.at(-1 - index), { state: "completed" });
  await fresh.save(acceptedRecord("another-running"));
  assert.equal((await readdir(root)).filter(name => name.endsWith(".json")).length, 200);
  assert.equal((await fresh.load(accepted.recordId)).state, "accepted");
});

test("isolates corrupt records without exposing their contents", async t => {
  const root = await mkdtemp(join(tmpdir(), "shengcheng-jobs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new VideoJobStore({ root });
  const valid = await store.save(record());
  const badId = "b".repeat(32);
  await writeFile(join(root, `${badId}.json`), "secret corrupt body", "utf8");
  const listed = await store.list();
  assert.deepEqual(listed.jobs.map(job => job.recordId), [valid.recordId]);
  assert.deepEqual(listed.invalid, [{ recordId: badId, message: "媒体任务记录损坏或无效" }]);
  assert.doesNotMatch(JSON.stringify(listed), /secret corrupt body/);
});
