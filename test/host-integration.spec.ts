// @ts-nocheck -- Cross-repository JavaScript plugin integration fixture.
import { afterEach, expect, it } from 'vitest'
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
const { closeMockServers, mockServer } = await import(/* @vite-ignore */ hostTestPath('tests/mock-server.ts'))

afterEach(async () => { await closeMockServers() })

it('dispatches the plugin selected route through the actual Host and adapter, validates and saves its result', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const server = await mockServer([{ body: JSON.stringify({ data: [{ b64_json: image }] }) }, { status: 500, body: '{}' }])
  const backup = await mockServer([{ body: JSON.stringify({ data: [{ b64_json: image }] }) }, { body: JSON.stringify({ data: [{ b64_json: image }] }) }])
  const root = await mkdtemp(join(tmpdir(), 'shengcheng-host-integration-'))
  const cwd = join(root, 'workspace'); await mkdir(cwd)
  const host = new Context(); await host.plugin(LlmRuntime)
  const profiles = resolveProfiles({ local: { api: 'openai-completions', baseURL: `${server.url}/v1`, apiKeyEnv: 'FAKE_KEY', models: [{ id: 'selected-image', name: 'Selected image' }] }, backup: { api: 'openai-completions', baseURL: `${backup.url}/v1`, apiKeyEnv: 'FAKE_KEY', models: [{ id: 'backup-image', name: 'Backup image' }] } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('fake-key'), auth: memoryAuth() })
  const dispose = host.llm.registerAdapter(['local', 'backup'], adapter)
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
    const model = catalog.groups.find(group => group.id === 'local').models.find(entry => entry.id === 'selected-image')
    expect(model.imageParameters.aspectRatios).toContain('3:2')
    expect(model.imageParameters.aspectRatios).not.toContain('16:9')
    registerShengchengTools(ctx, async () => ({ imageRoute: { provider: 'local', model: 'selected-image' }, imageFallbackRoute: { provider: 'backup', model: 'backup-image' }, outputDirectory: '' }))
    const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
    const result = await tool.execute({ prompt: 'draw a fixture', path: 'result.png' }, exec)
    expect(server.paths).toEqual(['/v1/images/generations'])
    expect(server.requests).toEqual([{ model: 'selected-image', prompt: 'draw a fixture', n: 1 }])
    expect(server.headers[0].authorization).toBe('Bearer fake-key')
    expect(await readFile(result.path)).toEqual(Buffer.from(image, 'base64'))
    const recovered = await tool.execute({ prompt: 'retry fixture', path: 'fallback.png' }, exec)
    expect(recovered.provider).toBe('backup')
    expect(recovered.model).toBe('backup-image')
    expect(backup.requests).toEqual([{ model: 'backup-image', prompt: 'retry fixture', n: 1 }])
    expect(await readFile(recovered.path)).toEqual(Buffer.from(image, 'base64'))
    const missingRoute = await tool.execute({ prompt: 'bad', provider: 'local', model: 'missing' }, exec)
    expect(missingRoute.provider).toBe('backup')
    expect(missingRoute.model).toBe('backup-image')
    await expect(tool.execute({ prompt: 'denied', path: '../escape.png' }, exec)).rejects.toThrow(/workspace-write/)
    expect(server.paths).toHaveLength(2)
    expect(backup.paths).toHaveLength(2)
  } finally { dispose(); await host.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 20000)
