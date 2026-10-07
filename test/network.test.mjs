import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { downloadBytes, isPublicAddress } from "../lib/network.js";

function mockNetwork(t, replies, records = [{ address: "93.184.216.34", family: 4 }]) {
  const calls = [], responses = [], lookups = [];
  t.mock.method(dns, "lookup", async (...args) => { lookups.push(args); return records; });
  t.mock.method(https, "request", (url, options, callback) => {
    calls.push({ url: String(url), options });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const reply = replies.shift();
      assert.ok(reply, "unexpected request must never reach the real network");
      const response = Readable.from(reply.chunks || [Buffer.from("valid-body")]);
      response.statusCode = reply.status || 200;
      response.headers = reply.headers || {};
      responses.push(response);
      callback(response);
    });
    return request;
  });
  return { calls, responses, lookups };
}

const signal = () => AbortSignal.timeout(5_000);

test("only global unicast IPs are allowed including IPv6 and alternate URL encodings", async (t) => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  const mock = mockNetwork(t, []);
  for (const url of ["https://127.1/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/", "https://[::ffff:127.0.0.1]/"]) await assert.rejects(downloadBytes(url, signal(), 100), /内网|保留/);
  assert.equal(mock.calls.length, 0);
});

test("a mixed public/private DNS result is rejected before connecting", async t => {
  const mock = mockNetwork(t, [], [{ address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 }]);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /内网|保留/);
  assert.equal(mock.calls.length, 0);
});

test("connection lookup is pinned while URL hostname and TLS validation remain intact", async t => {
  const mock = mockNetwork(t, [{}]);
  await downloadBytes("https://cdn.example/a", signal(), 100);
  const { url, options } = mock.calls[0];
  assert.equal(url, "https://cdn.example/a");
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  assert.notEqual(options.rejectUnauthorized, false);
  assert.equal(new Headers(options.headers).has("authorization"), false);
  const value = await new Promise((resolve, reject) => options.lookup("cdn.example", {}, (e, address, family) => e ? reject(e) : resolve({ address, family })));
  assert.deepEqual(value, { address: "93.184.216.34", family: 4 });
  assert.equal(mock.lookups.length, 1, "socket lookup must not re-resolve potentially rebound DNS");
});

test("every redirect is validated and private redirects never open a socket", async t => {
  const mock = mockNetwork(t, [{ status: 302, headers: { location: "https://127.0.0.1:9443/private" } }]);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /内网|保留/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.responses[0].destroyed, true);
});

test("HTTPS redirects download without credentials and HTTP redirects fail", async t => {
  const mock = mockNetwork(t, [{ status: 302, headers: { location: "https://other.example/b" } }, {}, { status: 302, headers: { location: "http://other.example/b" } }]);
  assert.equal((await downloadBytes("https://cdn.example/a", signal(), 100)).toString(), "valid-body");
  assert.equal(mock.lookups.length, 2);
  for (const call of mock.calls) assert.equal(new Headers(call.options.headers).has("authorization"), false);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /HTTPS/);
  assert.ok(mock.responses.every(response => response.destroyed));
});

test("redirect loops are capped and all response streams destroyed", async t => {
  const mock = mockNetwork(t, Array.from({ length: 6 }, () => ({ status: 302, headers: { location: "/again" } })));
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /重定向过多/);
  assert.equal(mock.calls.length, 6);
  assert.ok(mock.responses.every(response => response.destroyed));
});

test("content-length and streaming limits reject oversized bodies", async t => {
  const mock = mockNetwork(t, [
    { headers: { "content-length": "101" } },
    { chunks: [Buffer.alloc(60), Buffer.alloc(60)] },
    { headers: { "content-length": "20" }, chunks: [Buffer.alloc(10)] },
  ]);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /大小上限/);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /大小上限/);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /不完整/);
  assert.ok(mock.responses.every(response => response.destroyed));
});

test("HTML, compressed content and HTTP errors close the download", async t => {
  const mock = mockNetwork(t, [{ headers: { "content-type": " text/html" } }, { headers: { "content-encoding": "gzip" } }, { status: 500 }]);
  for (let i = 0; i < 3; i++) await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100));
  assert.ok(mock.responses.every(response => response.destroyed));
});

test("tiny chunks remain bounded and transport errors never expose signed URL text", async t => {
  const mock = mockNetwork(t, [{ chunks: Array.from({ length: 120 }, () => Buffer.from([1])) }]);
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), /大小上限/);
  assert.equal(mock.responses[0].destroyed, true);
  t.mock.method(dns, "lookup", async () => { throw new Error("https://cdn.example/a?signature=fixture-secret"); });
  await assert.rejects(downloadBytes("https://cdn.example/a", signal(), 100), error => {
    assert.match(error.message, /网络|DNS/);
    assert.doesNotMatch(error.message, /signature|fixture-secret/);
    return true;
  });
});

test("cancel during pending DNS returns promptly without requests or retry", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  t.mock.method(https, "request", () => { calls++; throw new Error("network forbidden"); });
  const pending = downloadBytes("https://cdn.example/a", controller.signal, 100);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
});
