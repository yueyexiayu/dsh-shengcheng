import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostRoot = process.env.DSH_HOST_SOURCE_ROOT
if (!hostRoot) throw new Error('DSH_HOST_SOURCE_ROOT is required for Host integration validation')
const tsconfigPaths = (await import(pathToFileURL(resolve(hostRoot, 'node_modules/vite-tsconfig-paths/dist/index.js')).href)).default
const { standardDecoratorPlugin } = await import(pathToFileURL(resolve(hostRoot, 'vitest.shared.ts')).href)
export default {
  plugins: [tsconfigPaths({ projects: [resolve(hostRoot, 'tsconfig.base.json')] }), standardDecoratorPlugin()],
  resolve: { alias: [
    { find: 'vitest', replacement: resolve(hostRoot, 'node_modules/vitest/dist/index.js') },
    { find: '@deepseek-ai/cordis', replacement: resolve(hostRoot, 'vendor/cordis/src/index.ts') },
    { find: '@deepseek-ai/dsh-llm-pi-ai', replacement: resolve(hostRoot, 'packages/llm/llm-pi-ai/src/index.ts') },
    { find: '@deepseek-ai/dsh-llm', replacement: resolve(hostRoot, 'packages/llm/llm/src/index.ts') },
  ] },
  test: { include: ['test/host-integration.spec.ts'], testTimeout: 20000 },
}
