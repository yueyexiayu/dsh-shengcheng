import test from "node:test";
import assert from "node:assert/strict";
import {
  accountIdFromJwt,
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

test("gptSize maps aspect ratios", () => {
  assert.equal(gptSize("1:1"), "1024x1024");
  assert.equal(gptSize("16:9"), "1536x1024");
  assert.equal(gptSize("9:16"), "1024x1536");
  assert.equal(gptSize("1:1", "1024x1536"), "1024x1536");
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

test("video poll treats 202 as pending and done as url", () => {
  assert.equal(videoPollState(202, { status: "pending" }).state, "pending");
  const done = videoPollState(200, { status: "done", video: { url: "https://vidgen.x.ai/a.mp4", duration: 2 } });
  assert.equal(done.state, "done");
  assert.equal(done.duration, 2);
  assert.throws(() => videoPollState(200, { status: "failed", error: { message: "nope" } }), /nope/);
  assert.equal(videoRequestId({ request_id: "abc" }), "abc");
});

test("extForImageBytes detects png and jpeg", () => {
  assert.equal(extForImageBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "png");
  assert.equal(extForImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
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
  assert.equal(renderSaved("/tmp/a.png", "grok")[0].text, "saved /tmp/a.png\ngrok");
  assert.match(defaultFileName("grok", "image", "png", new Date("2026-03-21T12:03:04")), /^shengcheng-grok-image-.*\.png$/);
});
