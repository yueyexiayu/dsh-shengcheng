import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const defaults = { provider: 'auto', imageAspectRatio: 'auto', imageQuality: 'auto', videoResolution: '720p', videoDuration: 5, outputDirectory: '' };

function harness(handler) {
  let plugin, component, tree, dirty = true, cursor = 0;
  const hooks = [], effects = [], calls = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useEffect(effect) { const i = cursor++; if (!(i in hooks)) effects.push(() => { hooks[i] = effect(); }); },
  };
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load(spec) { assert.equal(spec.id, 'shengcheng'); plugin = spec.factory(name => { assert.equal(name, 'react'); return React; }); } } },
    AbortController,
    fetch: async (url, options) => {
      const call = { url, method: options.method, body: options.body && JSON.parse(options.body) };
      calls.push(call);
      const body = await handler(call);
      return { ok: body.ok, status: body.ok ? 200 : 400, json: async () => body };
    },
  });
  plugin.apply({ slots: { inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); callback(); }, register(options, value) { assert.equal(options.key, 'shengcheng'); component = value; } } });
  function render() { dirty = false; cursor = 0; tree = component(); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; return [node, ...(node.props.children || []).flatMap(nodes)]; }
  function text(node) { return typeof node === 'object' && node !== null ? (node.props.children || []).map(text).join('') : String(node ?? ''); }
  function label(name) { const item = nodes().find(node => node.type === 'label' && text(node).startsWith(name)); assert.ok(item, name); return item.props.children.find(child => child && typeof child === 'object'); }
  function button(name) { const item = nodes().find(node => node.type === 'button' && text(node) === name); assert.ok(item, name); return item; }
  async function settle() { for (let i = 0; i < 5; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); }
  return { calls, settle, nodes, text: () => text(tree), label, button, async change(name, value) { label(name).props.onChange({ target: { value } }); await settle(); }, async submit() { await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); } };
}

test('loads settings and only saves explicitly edited values', async () => {
  const app = harness(call => ({ ok: true, settings: call.body?.settings ?? defaults }));
  await app.settle();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].method, 'GET');
  assert.equal(app.button('保存设置').props.disabled, true);
  await app.change('默认图片提供方', 'gpt');
  await app.change('默认视频时长（秒）', '8');
  assert.equal(app.calls.length, 1, 'editing must not save');
  await app.submit();
  assert.deepEqual(app.calls[1], { url: '/api/shengcheng/settings', method: 'POST', body: { settings: { ...defaults, provider: 'gpt', videoDuration: 8 } } });
  assert.match(app.text(), /默认设置已保存/);
  assert.equal(app.button('保存设置').props.disabled, true);
});

test('shows a save error and keeps the unsaved draft', async () => {
  const app = harness(call => call.method === 'GET' ? { ok: true, settings: defaults } : { ok: false, error: '保存失败' });
  await app.settle();
  await app.change('默认保存目录', '/tmp/output');
  await app.submit();
  assert.match(app.text(), /保存失败/);
  assert.equal(app.label('默认保存目录').props.value, '/tmp/output');
  assert.equal(app.button('保存设置').props.disabled, false);
});

test('load errors are visible and do not offer an empty form', async () => {
  const app = harness(() => ({ ok: false, error: '设置不可读取' }));
  await app.settle();
  assert.match(app.text(), /设置不可读取/);
  assert.equal(app.nodes().some(node => node.type === 'form'), false);
  assert.equal(app.calls.length, 1);
});

test('provider-specific image options require an explicit correction after switching provider', async () => {
  const app = harness(call => ({ ok: true, settings: call.body?.settings ?? defaults }));
  await app.settle();
  await app.change('默认图片提供方', 'grok');
  assert.ok(app.label('默认图片比例').props.children.some(item => item?.props?.value === '16:9'));
  await app.change('默认图片比例', '16:9');
  await app.change('默认图片提供方', 'gpt');
  assert.equal(app.label('默认图片比例').props.value, '16:9');
  assert.equal(app.label('默认图片比例').props['aria-invalid'], true);
  assert.match(app.text(), /请调整后保存/);
  assert.equal(app.button('保存设置').props.disabled, true);
  assert.ok(app.label('默认图片质量').props.children.some(item => item?.props?.value === 'high'));
  await app.change('默认图片比例', '1:1');
  await app.change('默认图片质量', 'high');
  await app.change('默认图片提供方', 'auto');
  assert.equal(app.label('默认图片质量').props.value, 'high');
  assert.equal(app.button('保存设置').props.disabled, true);
  await app.change('默认图片质量', 'medium');
  assert.equal(app.button('保存设置').props.disabled, false);
  assert.equal(app.calls.length, 1);
});
