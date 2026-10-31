import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sessionKey = id => createHash("sha256").update(id).digest("hex");
const diagnostics = {
  submit_transport: "提交时连接发生异常，无法确认提供方是否受理",
  submit_http: "提交时收到异常 HTTP 响应，无法确认提供方是否受理",
  submit_invalid_json: "提交响应无法解析，无法确认提供方是否受理",
  submit_invalid_id: "提交响应没有有效的任务 ID，无法确认提供方是否受理",
  submit_response_too_large: "提交响应超过大小限制，无法确认提供方是否受理",
  submit_aborted: "提交过程被中断，无法确认提供方是否受理",
  accepted_persist_failed: "收到任务 ID 后本地记录失败，无法确认任务状态",
  poll_or_download: "已提交任务的状态查询或结果获取发生异常",
};
export function safeMediaDiagnostic(value) {
  if (!value || typeof value !== "object" || typeof value.mediaDiagnostic !== "string" || !Object.hasOwn(diagnostics, value.mediaDiagnostic)) return null;
  return { mediaDiagnostic: value.mediaDiagnostic, ...(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? { status: value.status } : {}) };
}
export function mediaDiagnosticMessage(value) {
  const diagnostic = safeMediaDiagnostic(value);
  return diagnostic ? diagnostics[diagnostic.mediaDiagnostic] + (diagnostic.status ? `（HTTP ${diagnostic.status}）` : "") : "";
}

export function createVideoGuard(path = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "shengcheng", "video-jobs.sqlite")) {
  function database() {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (session TEXT PRIMARY KEY, token TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, job_id TEXT, fingerprint TEXT, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS job_diagnostics (token TEXT PRIMARY KEY, diagnostic TEXT NOT NULL, status INTEGER)");
    return db;
  }
  function withDb(fn) { const db = database(); try { return fn(db); } finally { db.close(); } }
  return {
    acquire(session, route) {
      if (typeof session !== "string" || !session) throw new Error("无法识别当前会话，不能安全提交视频任务");
      const key = sessionKey(session), token = randomUUID();
      return withDb(db => {
        const result = db.prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, NULL, NULL, ?)").run(key, token, route.provider, route.model, Date.now());
        if (!result.changes) throw new Error("此会话已有状态未确认的视频任务，已阻止重复提交；请在生成插件设置中查询或确认处理后再继续 (MEDIA_JOB_UNCERTAIN)");
        return { key, token };
      });
    },
    accepted(lease, jobId, fingerprint) {
      if (!safeId(jobId) || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("上游任务 ID 或路线指纹无效");
      withDb(db => { if (!db.prepare("UPDATE jobs SET job_id=?, fingerprint=? WHERE session=? AND token=?").run(jobId, fingerprint, lease.key, lease.token).changes) throw new Error("视频任务锁已变化"); });
    },
    diagnose(lease, value) {
      const diagnostic = safeMediaDiagnostic(value);
      if (!diagnostic) return;
      withDb(db => db.prepare("INSERT OR REPLACE INTO job_diagnostics SELECT token, ?, ? FROM jobs WHERE session=? AND token=?").run(diagnostic.mediaDiagnostic, diagnostic.status ?? null, lease.key, lease.token));
    },
    release(lease) { withDb(db => { db.prepare("DELETE FROM jobs WHERE session=? AND token=?").run(lease.key, lease.token); db.prepare("DELETE FROM job_diagnostics WHERE token=?").run(lease.token); }); },
    list() { return withDb(db => db.prepare("SELECT jobs.session, jobs.token, provider, model, job_id AS jobId, fingerprint, created, diagnostic, status FROM jobs LEFT JOIN job_diagnostics ON jobs.token=job_diagnostics.token ORDER BY created").all().map(({ diagnostic, status, ...job }) => ({ ...job, diagnosticMessage: mediaDiagnosticMessage({ mediaDiagnostic: diagnostic, status }) }))); },
    find(token) { return withDb(db => db.prepare("SELECT session, token, provider, model, job_id AS jobId, fingerprint, created FROM jobs WHERE token=?").get(token)); },
    forSession(session) { return withDb(db => db.prepare("SELECT session, token, provider, model, job_id AS jobId, fingerprint FROM jobs WHERE session=?").get(sessionKey(session))); },
  };
}

export function videoJobsHandler(guard, llm) {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  return async request => {
    try {
      if (request.method === "GET") return reply(200, { ok: true, jobs: guard.list().map(({ session, ...job }) => job) });
      const body = await request.json();
      if (!body || !safeId(body.token) || !["check", "confirm"].includes(body.action)) return reply(400, { ok: false, error: "请求无效" });
      const job = guard.find(body.token);
      if (!job) return reply(404, { ok: false, error: "任务已处理或不存在" });
      if (body.action === "confirm") {
        guard.release({ key: job.session, token: job.token });
        return reply(200, { ok: true, state: "confirmed" });
      }
      if (!job.jobId || typeof llm?.getMediaJobStatus !== "function") return reply(200, { ok: true, state: "unknown" });
      const result = await llm.getMediaJobStatus({ provider: job.provider, model: job.model, jobId: job.jobId, routeFingerprint: job.fingerprint, signal: AbortSignal.timeout(15000) });
      if (result?.provider !== job.provider || result?.model !== job.model || result?.jobId !== job.jobId || !["pending", "completed", "failed"].includes(result.state)) throw new Error("查询结果无效");
      if (result.state === "failed") guard.release({ key: job.session, token: job.token });
      return reply(200, { ok: true, state: result.state, ...(result.state === "failed" && result.reason === "content_moderation" ? { reason: "content_moderation" } : {}) });
    } catch { return reply(503, { ok: false, error: "无法确认视频任务状态，请稍后重试；未解除保护" }); }
  };
}
