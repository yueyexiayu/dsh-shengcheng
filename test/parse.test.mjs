import test from "node:test";
import assert from "node:assert/strict";
import { defaultFileName, extForImageBytes, mediaUrl, renderSaved, resolveKind } from "../lib/parse.js";

test("media kind is validated", () => {
  assert.equal(resolveKind(), "image"); assert.equal(resolveKind("video"), "video"); assert.throws(() => resolveKind("audio"), /kind/);
});
test("structured saved paths preserve quotes, backslashes and newlines", () => {
  const path = '/tmp/图片 a\\\\b"c\nnext.png', text = renderSaved(path, "provider")[0].text;
  assert.deepEqual(JSON.parse(text.split("\n").at(-1).slice("shengcheng_result ".length)), { path });
  assert.match(defaultFileName("provider", "image", "png", new Date("2026-03-21T12:03:04")), /^shengcheng-provider-image-.*\.png$/);
});
test("image signatures and HTTPS media URLs are checked", () => {
  assert.equal(extForImageBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "png");
  assert.equal(extForImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
  for (const bytes of [Buffer.alloc(0), Buffer.from("<html>error</html>"), Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50])]) assert.equal(extForImageBytes(bytes), null);
  for (const url of ["http://example.com/a.png", "https://user:pass@example.com/a.png", "httpmalformed"]) assert.throws(() => mediaUrl(url), /地址|HTTPS/);
});
