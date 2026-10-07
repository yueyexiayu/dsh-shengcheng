import dns from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { mediaUrl } from "./parse.js";

class DownloadError extends Error {}
function checkedUrl(raw, base) {
  try { return new URL(mediaUrl(raw, base)); }
  catch { throw new DownloadError("生成文件地址必须是无账号信息的有效 HTTPS 地址"); }
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
// Conservative exclusions: special-use space, documentation, 6to4 and reserved ranges.
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // This also excludes mapped IPv4, ULA, link-local, loopback and NAT64 encodings.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function resolvePublic(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const records = family ? [{ address: hostname, family }]
    : await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new DownloadError("生成文件下载地址不能指向内网或保留地址");
  }
  return records[0];
}

function requestPinned(url, record, signal) {
  return new Promise((resolve, reject) => {
    // Keep the original hostname for Host/SNI/certificate verification. Pin DNS at
    // connection time, not only in the preflight check; never forward account headers.
    const request = https.request(url, {
      method: "GET", agent: false, signal, family: record.family, autoSelectFamily: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [record]) : callback(null, record.address, record.family),
      headers: { accept: "image/*,video/mp4,application/octet-stream", "accept-encoding": "identity" },
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

export async function downloadBytes(rawUrl, signal, maxBytes) {
  signal ||= AbortSignal.timeout(180_000);
  try { return await boundedDownload(rawUrl, signal, maxBytes); }
  catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof DownloadError) throw error;
    // Native DNS/TLS/stream exceptions may contain signed URLs or headers.
    throw new Error("生成文件下载失败（网络或 DNS 错误）");
  }
}

async function boundedDownload(rawUrl, signal, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new DownloadError("下载大小上限无效");
  let url = checkedUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const record = await resolvePublic(url, signal);
    const response = await requestPinned(url, record, signal);
    try {
      signal.throwIfAborted();
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        if (!location) throw new DownloadError("生成文件重定向缺少下载地址");
        if (redirects === 5) throw new DownloadError("生成文件下载重定向过多");
        url = checkedUrl(location, url);
        continue;
      }
      if (status < 200 || status >= 300) throw new DownloadError(`下载生成文件失败 (HTTP ${status})`);
      const type = String(response.headers["content-type"] || "").trim();
      if (/^(text\/|application\/(?:json|xml|xhtml))/i.test(type)) throw new DownloadError("生成文件下载响应不是图片或视频");
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") throw new DownloadError("生成文件下载使用了不支持的压缩编码");
      const declared = response.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        throw new DownloadError("生成文件超过下载大小上限");
      }
      let bytes = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
      let length = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const nextLength = length + chunk.length;
        if (nextLength > maxBytes) throw new DownloadError("生成文件超过下载大小上限");
        if (nextLength > bytes.length) {
          const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(nextLength, bytes.length * 2)));
          bytes.copy(grown, 0, 0, length);
          bytes = grown;
        }
        chunk.copy(bytes, length);
        length = nextLength;
      }
      signal.throwIfAborted();
      if (declared !== undefined && length !== Number(declared)) throw new DownloadError("生成文件下载不完整");
      return bytes.subarray(0, length);
    } finally {
      response.destroy();
    }
  }
  throw new DownloadError("生成文件下载重定向过多");
}
