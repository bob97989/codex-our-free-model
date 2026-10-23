import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const serverPath = path.join(root, 'bin', 'mcp-server.mjs')

test('portable MCP config declares its schema', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8'))
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  const server = manifest.mcpServers['our-free-model']
  assert.ok(server)
  assert.equal(server.type, 'stdio')
  assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'env', 'type'])
})

function startServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })
  return {
    child,
    request(id, method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000)
        waiters.set(id, message => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
  }
}

test('MCP server publishes the global sidebar app and structured settings', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofm-mcp-'))
  const server = startServer({ COFM_HOME: dataDir, CODEX_HOME: path.join(dataDir, 'codex') })
  t.after(() => {
    server.child.kill()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const init = await server.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  assert.equal(init.result.protocolVersion, '2025-11-25')
  assert.equal(init.result.capabilities.experimental['openai/settings'].readTool, 'settings.read')

  const tools = await server.request(2, 'tools/list')
  const open = tools.result.tools.find(tool => tool.name === 'open_our_free_model_config')
  assert.ok(open)
  assert.equal(open._meta.ui.resourceUri, 'ui://our-free-model/config.html')
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }])

  const resources = await server.request(3, 'resources/list')
  assert.equal(resources.result.resources[0].mimeType, 'text/html;profile=mcp-app')

  const resource = await server.request(4, 'resources/read', { uri: 'ui://our-free-model/config.html' })
  const html = resource.result.contents[0].text
  assert.match(html, /ui\/initialize/)
  assert.match(html, /panel_save_provider/)
  assert.match(html, /添加账号/)

  const snapshot = await server.request(5, 'tools/call', {
    name: 'panel_snapshot',
    arguments: {},
  })
  assert.equal(snapshot.result.isError, false)
  assert.equal(snapshot.result.structuredContent.gateway.running, false)
  assert.ok(Array.isArray(snapshot.result.structuredContent.registry))
})
