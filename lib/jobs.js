import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RECORDS = 200;
const RECORD_ID = /^[a-f0-9]{32}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROUTE_FINGERPRINT = /^[a-f0-9]{64}$/;
const STATES = new Set(["accepted", "completed", "failed"]);

export function videoJobsDirectory(home = process.env.DSH_HOME) {
  return join(typeof home === "string" && home.trim() ? home.trim() : join(homedir(), ".dsh"), "storages", "shengcheng", "video-jobs");
}

function routeText(value, limit) {
  return typeof value === "string" && value.trim() && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} 时间无效`);
  return value;
}

export function videoJobRecordId(input) {
  const identity = [input?.provider, input?.model, input?.jobId, input?.routeFingerprint].map(value => typeof value === "string" ? value : "");
  if (identity.some(value => !value)) throw new Error("媒体任务身份不完整");
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

function validateRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("媒体任务记录必须是对象");
  const allowed = ["version", "recordId", "provider", "model", "jobId", "routeFingerprint", "acceptedAt", "requestedPath", "state", "updatedAt"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("媒体任务记录包含未知字段");
  const provider = routeText(input.provider, 256), model = routeText(input.model, 512);
  if (!provider || !model || !JOB_ID.test(input.jobId) || !ROUTE_FINGERPRINT.test(input.routeFingerprint)) throw new Error("媒体任务身份无效");
  if (input.version !== RECORD_VERSION || !STATES.has(input.state)) throw new Error("媒体任务记录版本或状态无效");
  const acceptedAt = timestamp(input.acceptedAt, "接受"), updatedAt = timestamp(input.updatedAt, "更新");
  if (Date.parse(updatedAt) < Date.parse(acceptedAt)) throw new Error("媒体任务更新时间早于接受时间");
  if (input.requestedPath !== undefined && (typeof input.requestedPath !== "string" || !isAbsolute(input.requestedPath) || input.requestedPath.length > 4096 || /[\x00-\x1f\x7f]/.test(input.requestedPath))) throw new Error("媒体任务保存路径无效");
  const recordId = videoJobRecordId({ provider, model, jobId: input.jobId, routeFingerprint: input.routeFingerprint });
  if (input.recordId !== undefined && input.recordId !== recordId) throw new Error("媒体任务记录 ID 不匹配");
  return { version: RECORD_VERSION, recordId, provider, model, jobId: input.jobId, routeFingerprint: input.routeFingerprint, acceptedAt, ...(input.requestedPath === undefined ? {} : { requestedPath: input.requestedPath }), state: input.state, updatedAt };
}

export class VideoJobStore {
  constructor({ root = videoJobsDirectory(), now = () => new Date() } = {}) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("媒体任务目录必须是绝对路径");
    if (typeof now !== "function") throw new Error("媒体任务时钟无效");
    this.root = root;
    this.now = now;
  }

  path(recordId) {
    if (typeof recordId !== "string" || !RECORD_ID.test(recordId)) throw new Error("媒体任务记录 ID 无效");
    return join(this.root, `${recordId}.json`);
  }

  async save(input) {
    const record = validateRecord({ ...input, version: RECORD_VERSION, updatedAt: timestamp(input?.updatedAt ?? this.now().toISOString(), "更新") });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.prune();
    const path = this.path(record.recordId), temporary = join(this.root, `.${randomUUID()}.tmp`);
    let file, owned = false;
    try {
      file = await open(temporary, "wx", 0o600);
      owned = true;
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, path);
      owned = false;
      return record;
    } finally {
      if (file) await file.close().catch(() => {});
      if (owned) await unlink(temporary).catch(() => {});
    }
  }

  /** Keeps the directory bounded so accepted jobs cannot grow it without limit. */
  async prune(keep = MAX_RECORDS - 1) {
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const files = names.filter(name => name.endsWith(".json") && RECORD_ID.test(name.slice(0, -5)));
    if (files.length <= keep) return;
    const excess = files.length - keep;
    const dated = await Promise.all(files.map(async name => {
      try { return { name, at: (await stat(join(this.root, name))).mtimeMs }; }
      catch { return null; }
    }));
    const oldest = dated.filter(Boolean).sort((a, b) => a.at - b.at).slice(0, excess + 8);
    // Only the eviction window is read: a finished job is worth less than one
    // that may still be recoverable through `resume`.
    const classified = await Promise.all(oldest.map(async item => {
      const path = join(this.root, item.name);
      try { return { ...item, terminal: ["completed", "failed"].includes(JSON.parse(await readFile(path, "utf8"))?.state) }; }
      catch { return { ...item, terminal: false }; }
    }));
    const ordered = classified.sort((a, b) => Number(b.terminal) - Number(a.terminal) || a.at - b.at);
    await Promise.all(ordered.slice(0, excess).map(item => unlink(join(this.root, item.name)).catch(() => {})));
  }

  async load(recordId) {
    const path = this.path(recordId);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("媒体任务记录无效或超过大小上限");
    const body = await readFile(path, "utf8");
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new Error("媒体任务记录不是有效 JSON"); }
    const record = validateRecord(parsed);
    if (record.recordId !== recordId) throw new Error("媒体任务记录 ID 不匹配");
    return record;
  }

  async list() {
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error.code === "ENOENT") return { jobs: [], invalid: [] }; throw error; }
    const files = names.filter(name => name.endsWith(".json") && RECORD_ID.test(name.slice(0, -5)));
    const dated = await Promise.all(files.map(async name => {
      try { return { name, at: (await stat(join(this.root, name))).mtimeMs }; }
      catch { return null; }
    }));
    // Read the newest records: truncating the raw directory order would hide them.
    const source = dated.filter(Boolean).sort((a, b) => b.at - a.at).slice(0, MAX_RECORDS);
    const jobs = [], invalid = [];
    await Promise.all(source.map(async item => {
      const recordId = item.name.slice(0, -5);
      try { jobs.push(await this.load(recordId)); }
      catch { invalid.push({ recordId, message: "媒体任务记录损坏或无效" }); }
    }));
    jobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { jobs, invalid };
  }

  async update(recordId, patch) {
    const current = await this.load(recordId);
    return this.save({ ...current, ...patch, recordId, updatedAt: this.now().toISOString() });
  }

  async remove(recordId) {
    const path = this.path(recordId);
    try { await unlink(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
}

export function createVideoJobStore(options) {
  return new VideoJobStore(options);
}
