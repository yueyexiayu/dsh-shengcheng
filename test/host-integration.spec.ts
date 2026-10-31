// @ts-nocheck -- Cross-repository JavaScript plugin integration fixture.
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { registerShengchengTools } from '../lib/tools.js'
import { listHostModelCatalog } from '../lib/model-catalog.js'
import { preflightMediaValidation } from '../lib/validate-media.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostRoot = process.env.DSH_HOST_SOURCE_ROOT
if (!hostRoot) throw new Error('DSH_HOST_SOURCE_ROOT is required for Host integration validation')
const hostTestPath = path => pathToFileURL(join(hostRoot, 'packages/llm/llm-pi-ai', path)).href
const { resolveProfiles } = await import(/* @vite-ignore */ hostTestPath('src/config.ts'))
const { memoryAuth } = await import(/* @vite-ignore */ hostTestPath('tests/auth-double.ts'))
afterEach(() => { vi.unstubAllGlobals() })

it('uses the configured provider metadata, submits its selected video and safely saves the completed media', async () => {
  const { ffmpeg } = await preflightMediaValidation()
  const video = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=5', '-t', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'])
  const requests = []
  const directory = { schema_version: 3, models: [{ id: 'video-a', category: 'videos', method: 'POST', path: '/v1/videos', query_path: '/v1/videos/{task_id}', content_path: '/v1/videos/{task_id}/content', parameters: { model: { required: true }, prompt: { required: true }, seconds: { minimum: 2, maximum: 10 }, resolution: { listed_values: ['768P'] }, content: { items: { properties: { type: { listed_values: ['image_url'] }, role: { listed_values: ['first_frame'] }, image_url: { properties: { url: { type: 'string' } } } } } } } }] }
  directory.models.push({ ...directory.models[0], id: 'video-b' })
  directory.models.push({ ...directory.models[0], id: 'video-c', parameters: { model: { required: true }, prompt: { required: true } } })
  let primaryUnavailable = false
  vi.stubGlobal('fetch', async (url, options) => {
    const headers = new Headers(options.headers)
    requests.push({ url: String(url), method: options.method, authorization: headers.get('authorization'), body: options.body && JSON.parse(options.body) })
    if (url === 'https://provider.example/docs-data/models.json') return Response.json(directory)
    if (url === 'https://provider.example/v1/models') return Response.json({ data: [{ id: 'video-a' }, { id: 'video-b' }, { id: 'video-c' }, { id: 'chat-only' }] })
    if (url === 'https://provider.example/v1/videos' && options.method === 'POST') {
      const model = JSON.parse(options.body).model
      if (model === 'chat-only') return Response.json({ error: 'private provider response' }, { status: 400 })
      if (model === 'video-a' && primaryUnavailable) return Response.json({ error: 'private unavailable details' }, { status: 503 })
      return Response.json({ id: 'job-1' })
    }
    if (url === 'https://provider.example/v1/videos/job-1') return Response.json({ id: 'job-1', status: 'completed' })
    if (url === 'https://provider.example/v1/videos/job-1/content') return new Response(video, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('unexpected network call')
  })
  const root = await mkdtemp(join(tmpdir(), 'shengcheng-host-integration-'))
  const cwd = join(root, 'workspace'); await mkdir(cwd)
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(cwd, 'reference.png'), image)
  const host = new Context(); await host.plugin(LlmRuntime)
  const profiles = resolveProfiles({ custom: { api: 'openai-completions', baseURL: 'https://provider.example/v1', apiKeyEnv: 'FAKE_KEY', models: [{ id: 'video-a', name: 'Video A' }, { id: 'video-b', name: 'Video B' }, { id: 'video-c', name: 'Video C' }, { id: 'chat-only', name: 'Chat only' }] } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fake-key'), auth: memoryAuth() })
  const dispose = host.llm.registerAdapter(['custom'], adapter)
  const canonical = async path => { try { return await realpath(path) } catch (error) { if (error.code !== 'ENOENT') throw error; return join(await canonical(dirname(path)), path.slice(dirname(path).length + 1)) } }
  let tool
  const ctx = {
    llm: host.llm,
    tools: { register: value => { tool = value } },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) },
    fs: {
      resolve: async (path, options) => ({ displayPath: resolve(options?.cwd || cwd, path), targetKey: await canonical(resolve(options?.cwd || cwd, path)) }),
      processPath: target => target.targetKey,
      stat: async target => { const info = await stat(target.targetKey); return { type: info.isFile() ? 'file' : 'directory', size: info.size } },
      readBytes: async target => readFile(target.targetKey),
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
    const group = catalog.groups.find(group => group.id === 'custom')
    expect(group.models.find(model => model.id === 'video-a')).toMatchObject({ video: 'unverified', image: 'unavailable', videoParameters: { duration: { min: 2, max: 10 }, resolutions: ['768p'] } })
    expect(group.models.find(model => model.id === 'chat-only').video).toBe('unavailable')
    expect(catalog.mediaFailures).toEqual([])
    registerShengchengTools(ctx, async () => ({ videoRoute: { provider: 'custom', model: 'video-a' }, videoResolution: '720p', videoDuration: 5, outputDirectory: '' }))
    const exec = { agent: { session: { id: 'session-fixture', header: { cwd } } }, signal: new AbortController().signal }
    const result = await tool.execute({ kind: 'video', prompt: 'move fixture', image_path: 'reference.png', path: 'result.mp4' }, exec)
    expect(result).toMatchObject({ provider: 'custom', model: 'video-a', kind: 'video' })
    expect(await readFile(result.path)).toEqual(video)
    expect(requests.find(item => item.method === 'POST')).toMatchObject({ url: 'https://provider.example/v1/videos', authorization: 'Bearer fake-key', body: { model: 'video-a', prompt: 'move fixture', seconds: 5, content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` }, role: 'first_frame' }] } })
    expect(requests.find(item => item.method === 'POST').body.resolution).toBe('720p')
    const explicit = await tool.execute({ kind: 'video', prompt: 'explicit resolution', resolution: '768p', path: 'explicit.mp4' }, exec)
    expect(await readFile(explicit.path)).toEqual(video)
    expect(requests.filter(item => item.method === 'POST')[1].body.resolution).toBe('768P')
    expect(requests.find(item => item.url.endsWith('/content')).authorization).toBe('Bearer fake-key')
    expect(requests.filter(item => item.url.endsWith('/docs-data/models.json')).every(item => !item.authorization)).toBe(true)
    await expect(tool.execute({ kind: 'video', prompt: 'bad', provider: 'custom', model: 'chat-only' }, exec)).rejects.toThrow(/上游生成失败/)
    await expect(tool.execute({ kind: 'video', prompt: 'denied', path: '../escape.mp4' }, exec)).rejects.toThrow(/workspace-write/)
    expect(requests.filter(item => item.method === 'POST').map(item => item.body.model)).toEqual(['video-a', 'video-a', 'chat-only'])
    primaryUnavailable = true
    requests.length = 0
    registerShengchengTools(ctx, async () => ({ videoRoute: { provider: 'custom', model: 'video-a' }, videoFallbackRoute: { provider: 'custom', model: 'video-b' }, videoResolution: '720p', videoDuration: 5, outputDirectory: '' }))
    const recovered = await tool.execute({ kind: 'video', prompt: 'move fixture', image_path: 'reference.png', duration: 3, resolution: '768p', path: 'fallback-result.mp4' }, exec)
    expect(recovered).toMatchObject({ provider: 'custom', model: 'video-b', kind: 'video' })
    expect(await readFile(recovered.path)).toEqual(video)
    const submitted = requests.filter(item => item.method === 'POST')
    expect(submitted.map(item => item.body.model)).toEqual(['video-a', 'video-b'])
    for (const item of submitted) expect(item.body).toMatchObject({ seconds: 3, resolution: '768P', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` }, role: 'first_frame' }] })
    requests.length = 0
    registerShengchengTools(ctx, async () => ({ videoRoute: { provider: 'custom', model: 'video-a' }, videoFallbackRoute: { provider: 'custom', model: 'video-c' }, outputDirectory: '' }))
    await expect(tool.execute({ kind: 'video', prompt: 'move fixture', image_path: 'reference.png' }, exec)).rejects.toThrow(/兜底模型 custom\/video-c.*MEDIA_REFERENCE_UNAVAILABLE/)
    expect(requests.filter(item => item.method === 'POST').map(item => item.body.model)).toEqual(['video-a'])
  } finally { dispose(); await host.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 90000)
