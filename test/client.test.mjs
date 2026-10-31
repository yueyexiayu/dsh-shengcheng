import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const legacy = { provider: 'gpt', imageAspectRatio: '3:2', imageQuality: 'medium', videoResolution: '720p', videoDuration: 5, outputDirectory: 'output', grokImageModel: 'old-grok', gptImageModel: 'old-gpt', grokVideoModel: 'old-video' };
const defaults = { imageRoute: null, videoRoute: null, imageFallbackRoute: null, videoFallbackRoute: null, imageAspectRatio: '3:2', imageQuality: 'medium', videoResolution: '720p', videoDuration: 5, outputDirectory: 'output', legacySettings: legacy };
const catalog = { groups: [{ id: 'p1', name: 'Provider One', models: [{ id: 'same', name: 'Same', image: 'declared', video: 'unavailable', imageParameters: { aspectRatios: ['1:1', '3:2'], qualities: ['low', 'medium', 'high'] } }, { id: 'video', name: 'Video', image: 'unavailable', video: 'unverified', videoParameters: { resolutions: ['480p', '720p'], duration: { min: 1, max: 15 } } }] }, { id: 'p2', name: 'Provider Two', models: [{ id: 'same', name: 'Same', image: 'unverified', video: 'unavailable', imageParameters: { aspectRatios: ['1:1'], qualities: ['low'] } }] }], failures: [], mediaFailures: [] };

function harness(handler) {
  let plugin, component, tree, dirty = true, cursor = 0;
  const hooks = [], effects = [], calls = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useEffect(effect) { const i = cursor++; if (!(i in hooks)) effects.push(() => { hooks[i] = effect(); }); },
  };
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load(spec) { plugin = spec.factory(name => { assert.equal(name, 'react'); return React; }); } } }, AbortController, fetch: async (url, options) => {
    const call = { url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) }; calls.push(call);
    const body = await handler(call); return { ok: body.ok, status: body.ok ? 200 : 503, json: async () => body };
  } });
  plugin.apply({ slots: { inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); callback(); }, register(options, value) { assert.equal(options.key, 'shengcheng'); component = value; } } });
  function render() { dirty = false; cursor = 0; tree = component(); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; return [node, ...(node.props.children || []).flatMap(nodes)]; }
  function text(node) { return typeof node === 'object' && node !== null ? (node.props.children || []).map(text).join('') : String(node ?? ''); }
  function label(name) { const item = nodes().find(node => node.type === 'label' && text(node).startsWith(name)); assert.ok(item, name); return item.props.children.find(child => child && typeof child === 'object'); }
  function button(name) { const item = nodes().find(node => node.type === 'button' && text(node) === name); assert.ok(item, name); return item; }
  async function settle() { for (let i = 0; i < 5; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); }
  return { calls, settle, label, button, text: () => text(tree), async change(name, value) { label(name).props.onChange({ target: { value } }); await settle(); }, async submit() { await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); } };
}

test('selects DSH provider and model as a pair, and preserves old settings on save', async () => {
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog } : { ok: true, revision: 'revision-1', settings: call.body?.settings ?? defaults });
  await app.settle();
  assert.match(app.text(), /旧版模型设置已保留/);
  assert.match(app.text(), /每次尝试的总超时均为 600 秒/);
  assert.match(app.text(), /最多约 1200 秒/);
  const image = app.label('默认图片模型').props.children;
  assert.notEqual(image.find(x => x?.props?.value === JSON.stringify(['p2', 'same'])).props.disabled, true);
  await app.change('默认图片模型', JSON.stringify(['p1', 'same']));
  await app.change('默认视频模型', JSON.stringify(['p1', 'video']));
  assert.equal(app.button('保存设置').props.disabled, false);
  await app.submit();
  const saved = app.calls.find(call => call.method === 'POST').body.settings;
  assert.equal(app.calls.find(call => call.method === 'POST').body.revision, 'revision-1');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.imageRoute)), { provider: 'p1', model: 'same' });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.videoRoute)), { provider: 'p1', model: 'video' });
  assert.deepEqual(saved.legacySettings, legacy);
  assert.match(app.text(), /默认设置已保存/);
});

test('unset routes retain defaults without labeling them incompatible', async () => {
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog } : { ok: true, revision: 'r1', settings: defaults });
  await app.settle();
  const resolution = app.label('默认视频分辨率');
  const option = resolution.props.children.find(item => item?.props?.value === '720p');
  assert.equal(resolution.props.value, '720p');
  assert.equal(option.props.children.join(''), '720p');
  assert.notEqual(option.props.disabled, true);
});

test('switching routes preserves defaults and offers common values without asserting support', async () => {
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog } : { ok: true, settings: defaults });
  await app.settle();
  await app.change('默认图片模型', JSON.stringify(['p2', 'same']));
  assert.match(app.text(), /是否支持以提供方实际调用结果为准/);
  assert.equal(app.button('保存设置').props.disabled, false);
  assert.equal(app.label('默认图片比例').props.value, '3:2');
  assert.notEqual(app.label('默认图片比例').props.children.find(item => item?.props?.value === '16:9').props.disabled, true);
  assert.notEqual(app.label('默认图片质量').props.children.find(item => item?.props?.value === 'high').props.disabled, true);
});

test('fallback does not restrict common defaults and rejects the main route itself', async () => {
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog } : { ok: true, revision: 'r1', settings: defaults });
  await app.settle();
  await app.change('默认图片模型', JSON.stringify(['p1', 'same']));
  await app.change('图片兜底模型', JSON.stringify(['p1', 'same']));
  assert.match(app.text(), /兜底模型与主模型相同/);
  await app.change('图片兜底模型', JSON.stringify(['p2', 'same']));
  assert.equal(app.button('保存设置').props.disabled, false);
  assert.notEqual(app.label('默认图片比例').props.children.find(item => item?.props?.value === '3:2').props.disabled, true);
});

test('common options remain available without metadata and include extra provider values', async () => {
  const data = { groups: [{ id: 'p', name: 'P', models: [{ id: 'one', name: 'One', image: 'unknown', video: 'unknown' }, { id: 'two', name: 'Two', video: 'declared', videoParameters: { resolutions: ['768p'] } }] }], failures: [], mediaFailures: [] };
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog: data } : { ok: true, revision: 'r1', settings: call.body?.settings ?? defaults });
  await app.settle();
  await app.change('默认图片模型', JSON.stringify(['p', 'one']));
  await app.change('默认视频模型', JSON.stringify(['p', 'one']));
  await app.change('视频兜底模型', JSON.stringify(['p', 'two']));
  for (const [field, values] of [['默认图片比例', ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4']], ['默认图片质量', ['low', 'medium', 'high']], ['默认视频分辨率', ['480p', '720p', '1080p', '768p']]]) {
    const options = app.label(field).props.children;
    for (const value of values) assert.notEqual(options.find(item => item?.props?.value === value)?.props.disabled, true, `${field}: ${value}`);
    for (const value of values) assert.ok(options.find(item => item?.props?.value === value), `${field}: ${value}`);
  }
  await app.change('默认图片比例', '16:9');
  await app.change('默认图片质量', 'high');
  await app.change('默认视频分辨率', '1080p');
  assert.equal(app.button('保存设置').props.disabled, false);
  await app.submit();
  const saved = app.calls.find(call => call.method === 'POST').body.settings;
  assert.equal(saved.imageAspectRatio, '16:9'); assert.equal(saved.imageQuality, 'high'); assert.equal(saved.videoResolution, '1080p');
});

test('incompatible saved resolution is explained without changing it or blocking save', async () => {
  const result = { groups: [{ id: 'p', name: 'P', models: [{ id: 'v', name: 'V', video: 'declared', videoParameters: { resolutions: ['768P'] } }] }], failures: [], mediaFailures: [], mediaEmpty: [] };
  const settings = { ...defaults, videoRoute: { provider: 'p', model: 'v' }, videoResolution: '480p' };
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog: result } : { ok: true, revision: 'r', settings: call.body?.settings ?? settings });
  await app.settle();
  assert.match(app.text(), /默认视频分辨率不在主模型的已知参数中/);
  assert.equal(app.label('默认视频分辨率').props.value, '480p');
  await app.change('默认视频时长', '6');
  assert.equal(app.button('保存设置').props.disabled, false);
  await app.submit();
  assert.equal(app.calls.find(call => call.method === 'POST').body.settings.videoResolution, '480p');
});

test('failed catalog is visible and does not silently expose an empty successful list', async () => {
  const app = harness(call => call.url.endsWith('/models') ? { ok: false, error: '模型目录不可用' } : { ok: true, settings: defaults });
  await app.settle();
  assert.match(app.text(), /模型目录不可用/);
  assert.equal(app.label('默认图片模型').props.disabled, true);
});

test('unknown and unlisted models remain selectable and savable in each selector', async () => {
  const result = { groups: [{ id: 'p', name: 'P', models: [{ id: 'chat', name: 'Chat', image: 'unknown', video: 'unavailable' }] }], failures: [], mediaFailures: [{ provider: 'p', kind: 'image', reason: 'interface_missing', missing: ['listMediaModels', 'generateMedia'] }], mediaEmpty: [{ provider: 'p', kind: 'video' }] };
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog: result } : { ok: true, revision: 'r1', settings: call.body?.settings ?? defaults });
  await app.settle();
  assert.match(app.text(), /Host 缺少媒体生成接口/);
  for (const label of ['默认图片模型', '默认视频模型', '图片兜底模型', '视频兜底模型']) {
    assert.notEqual(app.label(label).props.children.find(x => x?.props?.value === JSON.stringify(['p', 'chat'])).props.disabled, true);
  }
  await app.change('默认图片模型', JSON.stringify(['p', 'chat']));
  await app.change('默认视频模型', JSON.stringify(['p', 'chat']));
  assert.equal(app.button('保存设置').props.disabled, false);
  await app.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.find(call => call.method === 'POST').body.settings.videoRoute)), { provider: 'p', model: 'chat' });
});

test('media catalog failures do not produce distracting per-provider errors', async () => {
  const result = { groups: [], failures: [], mediaFailures: [{ provider: 'a', kind: 'image', reason: 'call_failed' }, { provider: 'b', kind: 'video', reason: 'invalid_response' }, { provider: 'xai', kind: 'image', reason: 'missing_credential' }, { provider: 'c', kind: 'video', reason: 'catalog_unavailable' }], mediaEmpty: [] };
  const app = harness(call => call.url.endsWith('/models') ? { ok: true, catalog: result } : { ok: true, settings: defaults });
  await app.settle();
  assert.match(app.text(), /可自行选择模型和常规参数/);
  assert.doesNotMatch(app.text(), /媒体目录调用失败|媒体目录返回格式无效|媒体 API 凭据不可用/);
});
