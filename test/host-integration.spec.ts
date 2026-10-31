// @ts-nocheck -- Cross-repository JavaScript plugin integration fixture.
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { registerShengchengTools } from '../lib/tools.js'
import { listHostModelCatalog } from '../lib/model-catalog.js'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostRoot = process.env.DSH_HOST_SOURCE_ROOT
if (!hostRoot) throw new Error('DSH_HOST_SOURCE_ROOT is required for Host integration validation')
const hostTestPath = path => pathToFileURL(join(hostRoot, 'packages/llm/llm-pi-ai', path)).href
const { resolveProfiles } = await import(/* @vite-ignore */ hostTestPath('src/config.ts'))
const { memoryAuth } = await import(/* @vite-ignore */ hostTestPath('tests/auth-double.ts'))
afterEach(() => { vi.unstubAllGlobals() })

it('dispatches the plugin selected route through the actual Host and adapter, validates and saves its result', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const requests = []
  vi.stubGlobal('fetch', async (url, options) => {
    requests.push({ url: String(url), method: options.method, headers: options.headers, body: options.body && JSON.parse(options.body) })
    if (url === 'https://api.openai.com/v1/models' && options.method === 'GET') return Response.json({ data: [{ id: 'gpt-image-2' }, { id: 'ordinary-chat-model' }] })
    if (url === 'https://api.openai.com/v1/images/generations' && options.method === 'POST') return Response.json({ data: [{ b64_json: image }] })
    throw new Error('unexpected network call')
  })
  const root = await mkdtemp(join(tmpdir(), 'shengcheng-host-integration-'))
  const cwd = join(root, 'workspace'); await mkdir(cwd)
  const host = new Context(); await host.plugin(LlmRuntime)
  const profiles = resolveProfiles({ openai: { apiKeyEnv: 'FAKE_KEY' } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fake-key'), auth: memoryAuth() })
  const dispose = host.llm.registerAdapter(['openai'], adapter)
  const canonical = async path => { try { return await realpath(path) } catch (error) { if (error.code !== 'ENOENT') throw error; return join(await canonical(dirname(path)), path.slice(dirname(path).length + 1)) } }
  let tool
  const ctx = {
    llm: host.llm,
    tools: { register: value => { tool = value } },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) },
    fs: {
      resolve: async (path, options) => ({ displayPath: resolve(options?.cwd || cwd, path), targetKey: await canonical(resolve(options?.cwd || cwd, path)) }),
      processPath: target => target.targetKey,
      checkedTarget: async (target, policy) => {
        const targetKey = await canonical(target.displayPath)
        const rel = relative(await realpath(policy.workspaceRoot), targetKey)
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('workspace-write denied')
        return { ...target, targetKey }
      },
    },
  }
  try {
    const catalog = await listHostModelCatalog(host.llm)
    const group = catalog.groups.find(group => group.id === 'openai')
    const model = group.models.find(entry => entry.id === 'gpt-image-2')
    expect(model.image).toBe('unverified')
    expect(model.video).toBe('unavailable')
    expect(group.models.find(entry => entry.id === 'ordinary-chat-model')?.image).not.toBe('declared')
    expect(catalog.mediaFailures).toEqual([])
    registerShengchengTools(ctx, async () => ({ imageRoute: { provider: 'openai', model: 'gpt-image-2' }, outputDirectory: '' }))
    const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
    const result = await tool.execute({ prompt: 'draw a fixture', path: 'result.png' }, exec)
    const posts = requests.filter(item => item.method === 'POST')
    expect(posts.map(item => item.url)).toEqual(['https://api.openai.com/v1/images/generations'])
    expect(posts[0].body).toEqual({ model: 'gpt-image-2', prompt: 'draw a fixture', n: 1 })
    expect(posts[0].headers.authorization).toBe('Bearer fake-key')
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-image-2')
    expect(await readFile(result.path)).toEqual(Buffer.from(image, 'base64'))
    await expect(tool.execute({ prompt: 'bad', provider: 'openai', model: 'ordinary-chat-model' }, exec)).rejects.toThrow(/目录失败/)
    await expect(tool.execute({ prompt: 'denied', path: '../escape.png' }, exec)).rejects.toThrow(/workspace-write/)
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
  } finally { dispose(); await host.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 20000)

it('exposes only declared xAI video routes and dispatches the selected asynchronous job', async () => {
  const requests = []
  vi.stubGlobal('fetch', async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: options.body && JSON.parse(options.body) })
    if (url === 'https://api.x.ai/v1/image-generation-models') return Response.json({ models: [] })
    if (url === 'https://api.x.ai/v1/video-generation-models') return Response.json({ models: [{ id: 'grok-imagine-video-1.5' }] })
    if (url === 'https://api.x.ai/v1/videos/generations') return Response.json({ request_id: 'fixture-job' })
    if (url === 'https://api.x.ai/v1/videos/fixture-job') return Response.json({ status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://video.example/result.mp4', duration: 5 } })
    throw new Error('unexpected network call')
  })
  const host = new Context(); await host.plugin(LlmRuntime)
  const profiles = resolveProfiles({ xai: { apiKeyEnv: 'FAKE_KEY' } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fake-key'), auth: memoryAuth() })
  const dispose = host.llm.registerAdapter(['xai'], adapter)
  try {
    const catalog = await listHostModelCatalog(host.llm)
    const route = catalog.groups.find(group => group.id === 'xai').models.find(model => model.id === 'grok-imagine-video-1.5')
    expect(route.video).toBe('declared')
    expect(route.videoParameters.duration).toEqual({ min: 1, max: 15 })
    expect(route.image).toBe('unavailable')
    const result = await host.llm.generateMedia({ provider: 'xai', model: route.id, kind: 'video', prompt: 'move', duration: 5 })
    expect(result).toEqual({ provider: 'xai', model: route.id, kind: 'video', url: 'https://video.example/result.mp4', duration: 5 })
    expect(requests.filter(item => item.method === 'POST')).toEqual([{ url: 'https://api.x.ai/v1/videos/generations', method: 'POST', body: { model: route.id, prompt: 'move', duration: 5 } }])
    expect(requests.some(item => item.url === 'https://api.x.ai/v1/videos/fixture-job')).toBe(true)
  } finally { dispose(); await host.fiber.dispose() }
}, 20000)
