import test from "node:test";
import assert from "node:assert/strict";
import {
  accountIdFromJwt,
  MAX_IMAGE_BYTES,
  defaultFileName,
  errorFromBody,
  extForImageBytes,
  gptSize,
  grantFromRecord,
  grokAspect,
  grokVideoResolution,
  httpErrorMessage,
  imagePayloadFromBody,
  normalizeProvider,
  renderSaved,
  resolveImageProvider,
  resolveKind,
  resolveVideoProvider,
  videoDuration,
  videoPollState,
  videoRequestId,
} from "../lib/parse.js";

test("normalizeProvider accepts grok/gpt aliases", () => {
  assert.equal(normalizeProvider("xai"), "grok");
  assert.equal(normalizeProvider("openai-codex"), "gpt");
  assert.equal(normalizeProvider("auto"), "auto");
  assert.equal(normalizeProvider(""), "auto");
  assert.equal(normalizeProvider("claude"), null);
});

test("resolveImageProvider prefers the current chat account then grok", () => {
  assert.equal(resolveImageProvider({ requested: "auto", current: "xai", grokOk: true, gptOk: true }), "grok");
  assert.equal(resolveImageProvider({ requested: "auto", current: "openai-codex", grokOk: true, gptOk: true }), "gpt");
  assert.equal(resolveImageProvider({ requested: "auto", current: "deepseek", grokOk: true, gptOk: true }), "grok");
  assert.equal(resolveImageProvider({ requested: "auto", current: "deepseek", grokOk: false, gptOk: true }), "gpt");
  assert.equal(resolveImageProvider({ requested: "gpt", current: "xai", grokOk: true, gptOk: true }), "gpt");
  assert.throws(() => resolveImageProvider({ requested: "auto", current: "deepseek", grokOk: false, gptOk: false }), /未登录/);
});

test("resolveKind defaults to image", () => {
  assert.equal(resolveKind(), "image");
  assert.equal(resolveKind("video"), "video");
  assert.throws(() => resolveKind("audio"), /kind/);
});

test("resolveVideoProvider is grok-only", () => {
  assert.equal(resolveVideoProvider({ requested: "auto", grokOk: true }), "grok");
  assert.throws(() => resolveVideoProvider({ requested: "gpt", grokOk: true }), /不能生成视频/);
  assert.throws(() => resolveVideoProvider({ requested: "auto", grokOk: false }), /只用 Grok/);
});

test("gptSize preserves exact supported ratios and rejects unsupported/conflicting inputs", () => {
  assert.equal(gptSize("1:1"), "1024x1024");
  assert.equal(gptSize("3:2"), "1536x1024");
  assert.equal(gptSize("2:3"), "1024x1536");
  assert.equal(gptSize("auto", "1024x1536"), "1024x1536");
  assert.equal(gptSize(), "1024x1024");
  for (const aspect of ["16:9", "9:16", "21:9", "bad", "toString", "__proto__"]) {
    assert.throws(() => gptSize(aspect), /本插件当前支持/);
  }
  assert.throws(() => gptSize("1:1", "1024x1536"), /不一致/);
  assert.throws(() => gptSize(null, "9999x9999"), /本插件当前支持/);
});

test("grok aspect and video limits", () => {
  assert.equal(grokAspect("16:9"), "16:9");
  assert.equal(grokAspect("auto"), null);
  assert.throws(() => grokAspect("17:9"), /aspect_ratio/);
  assert.throws(() => grokAspect("21:9", { video: true }), /aspect_ratio/);
  assert.equal(grokVideoResolution(""), "720p");
  assert.equal(videoDuration(), 5);
  assert.throws(() => videoDuration(20), /duration/);
});

test("imagePayloadFromBody reads b64", () => {
  const payload = imagePayloadFromBody({ data: [{ b64_json: Buffer.from("abc").toString("base64") }] });
  assert.equal(payload.kind, "b64");
  assert.equal(payload.bytes.toString(), "abc");
});

test("large valid base64 does not overflow the regexp stack", () => {
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  assert.deepEqual(imagePayloadFromBody({ data: [{ b64_json: bytes.toString("base64") }] }).bytes, bytes);
});

test("base64 payload enforces decoded size limit and canonical padding", () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  assert.equal(imagePayloadFromBody({ data: [{ b64_json: bytes.toString("base64") }] }).bytes.length, MAX_IMAGE_BYTES);
  assert.throws(() => imagePayloadFromBody({ data: [{ b64_json: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }] }), /32MiB/);
  for (const b64_json of ["AAAA=", "A===", "AB==", "AA=A", "AAAA\n", "===="]) {
    assert.throws(() => imagePayloadFromBody({ data: [{ b64_json }] }), /编码/);
  }
});

test("structured saved paths survive spaces, quotes, backslashes and newlines", () => {
  const path = '/tmp/图片 a\\\\b"c\nnext.png';
  const text = renderSaved(path, "grok")[0].text;
  assert.ok(text.startsWith(`saved ${path}\n`));
  const line = text.split("\n").at(-1);
  assert.deepEqual(JSON.parse(line.slice("shengcheng_result ".length)), { path });
});

test("video poll treats 202 as pending and done as url", () => {
  assert.equal(videoPollState(202, { status: "pending" }).state, "pending");
  const done = videoPollState(200, { status: "done", video: { url: "https://vidgen.x.ai/a.mp4", duration: 2 } });
  assert.equal(done.state, "done");
  assert.equal(done.duration, 2);
  assert.throws(() => videoPollState(200, { status: "failed", error: { message: "nope" } }), /nope/);
  assert.equal(videoRequestId({ request_id: "abc" }), "abc");
});

test("video duration metadata is finite nonnegative numeric or null", () => {
  const parse = duration => videoPollState(200, { status: "done", video: { url: "https://example.com/a.mp4", duration } }).duration;
  assert.equal(parse("2.5"), 2.5);
  assert.equal(parse(0), 0);
  for (const value of [undefined, null, "", " ", "bad", "-1", -1, NaN, Infinity, "Infinity", {}, [], true]) {
    assert.equal(parse(value), null);
  }
});

test("extForImageBytes detects png and jpeg", () => {
  assert.equal(extForImageBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "png");
  assert.equal(extForImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
});

test("unknown bytes, HTML and video are not images", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50])]) {
    assert.equal(extForImageBytes(bytes), null);
  }
});

test("invalid encodings and download addresses are refused", () => {
  assert.throws(() => imagePayloadFromBody({ data: [{ b64_json: "%%%invalid%%%" }] }), /编码/);
  for (const url of ["http://example.com/a.png", "https://user:pass@example.com/a.png", "httpmalformed"]) {
    assert.throws(() => imagePayloadFromBody({ data: [{ url }] }), /地址|HTTPS/);
  }
});

test("video polling rejects unrecognized states instead of waiting forever", () => {
  assert.throws(() => videoPollState(200, {}), /状态/);
  assert.throws(() => videoPollState(200, { status: "unexpected" }), /状态/);
});

test("grantFromRecord and jwt account id", () => {
  assert.equal(grantFromRecord(null), null);
  const grant = grantFromRecord({
    kind: "grant",
    payload: { access: "a", refresh: "b", expires: 1, accountId: "acc" },
  });
  assert.equal(grant.accountId, "acc");
  const jwt = "aaa." + Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })).toString("base64url") + ".sig";
  assert.equal(accountIdFromJwt(jwt), "acct-1");
});

test("errors stay short and render starts with saved", () => {
  assert.match(httpErrorMessage(401, null), /401/);
  assert.equal(errorFromBody({ error: { message: "bad prompt" } }), "bad prompt");
  assert.equal(renderSaved("/tmp/a.png", "grok")[0].text, 'saved /tmp/a.png\ngrok\nshengcheng_result {"path":"/tmp/a.png"}');
  assert.match(defaultFileName("grok", "image", "png", new Date("2026-03-21T12:03:04")), /^shengcheng-grok-image-.*\.png$/);
});
