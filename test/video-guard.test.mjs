import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVideoGuard, videoJobsHandler } from "../lib/video-guard.js";

test("video protection survives reopening and only a confirmed failure releases it", async t => {
  const root = await mkdtemp(join(tmpdir(), "video-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jobs.sqlite"), first = createVideoGuard(path);
  const lease = first.acquire("session-a", { provider: "p", model: "m" });
  first.accepted(lease, "job_123", "a".repeat(64));
  const reopened = createVideoGuard(path);
  assert.throws(() => reopened.acquire("session-a", { provider: "another", model: "changed" }), /状态未确认/);
  const other = reopened.acquire("session-b", { provider: "p", model: "m" });
  reopened.release(other);
  let state = "pending";
  const handler = videoJobsHandler(reopened, { getMediaJobStatus: async options => ({ ...options, state }) });
  const check = () => handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ action: "check", token: lease.token }) })).then(r => r.json());
  assert.equal((await check()).state, "pending");
  state = "completed";
  assert.equal((await check()).state, "completed");
  assert.throws(() => reopened.acquire("session-a", { provider: "p", model: "m" }), /状态未确认/);
  state = "failed";
  assert.equal((await check()).state, "failed");
  assert.ok(reopened.acquire("session-a", { provider: "p", model: "m" }));
});

test("no task ID remains unknown until explicit confirmation", async t => {
  const root = await mkdtemp(join(tmpdir(), "video-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = createVideoGuard(join(root, "jobs.sqlite")), lease = guard.acquire("session", { provider: "p", model: "m" });
  const handler = videoJobsHandler(guard, {});
  const action = async name => (await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ action: name, token: lease.token }) }))).json();
  assert.equal((await action("check")).state, "unknown");
  assert.equal(guard.list().length, 1);
  assert.equal((await action("confirm")).state, "confirmed");
  assert.equal(guard.list().length, 0);
});

test("existing protection is preserved while safe diagnostics persist without upstream data", async t => {
  const root = await mkdtemp(join(tmpdir(), "video-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jobs.sqlite"), old = new DatabaseSync(path);
  old.exec("CREATE TABLE jobs (session TEXT PRIMARY KEY, token TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, job_id TEXT, fingerprint TEXT, created INTEGER NOT NULL)");
  old.close();
  const guard = createVideoGuard(path), lease = guard.acquire("session", { provider: "p", model: "m" });
  guard.diagnose(lease, { mediaDiagnostic: "submit_http", status: 503, secret: "private-body" });
  const reopened = createVideoGuard(path), jobs = reopened.list();
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].diagnosticMessage, /HTTP 503/);
  assert.doesNotMatch(JSON.stringify(jobs), /private-body/);
  assert.throws(() => reopened.acquire("session", { provider: "different", model: "different" }), /状态未确认/);
  reopened.diagnose(lease, { mediaDiagnostic: "private-body", status: 777 });
  assert.doesNotMatch(JSON.stringify(reopened.list()), /private-body|777/);
  reopened.release(lease);
  assert.equal(reopened.list().length, 0);
});
