#!/usr/bin/env node
/**
 * Our Free Model — MCP server and sidebar configuration app.
 *
 * The model provider is still the local gateway. This process is the plugin's
 * Codex-facing control plane: it exposes the same free lane as tools, serves the
 * global sidebar app, and proxies authenticated settings calls to the gateway.
 * Credentials never enter the sandboxed UI; only masked account state crosses
 * that boundary.
 *
 * Transport is stdio with newline-delimited JSON-RPC.
 *
 * @module bin/mcp-server.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeProviderConfig } from '../src/codex-config.js'
import { offlinePanelSnapshot } from '../src/panel-controller.js'
import { VERSION } from '../src/service.js'

const SERVER_NAME = 'codex-our-free-model'
const SERVER_VERSION = VERSION
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2024-11-05']
const UI_RESOURCE_URI = 'ui://our-free-model/config.html'
const PANEL_HTML_PATH = fileURLToPath(new URL('../ui/panel.html', import.meta.url))
const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'cli.mjs')
const APP_ONLY = Object.freeze({
  ui: { visibility: ['app'] },
  'openai/visibility': 'private',
  'openai/widgetAccessible': true,
})
const EMPTY_INPUT = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })

/** Mirrors `resolveDataDir` in src/service.js without importing the service. */
export function resolveDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.COFM_HOME === 'string' ? env.COFM_HOME.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''
    ? path.resolve(env.CODEX_HOME.trim())
    : path.join(home, '.codex')
  return path.join(codexHome, 'our-free-model')
}

/** Read the gateway's port and key from the settings the service persists. */
export function readGatewaySettings(dataDir = resolveDataDir()) {
  const file = path.join(dataDir, 'settings.json')
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`could not read ${file}: ${error.message}`)
  }
  const forward = value?.forward ?? {}
  const port = Number(forward.port)
  const key = typeof value?.forwardKey === 'string' ? value.forwardKey : ''
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || key === '') return null
  const host = typeof forward.host === 'string' && forward.host !== '' && forward.host !== '0.0.0.0'
    ? forward.host
    : '127.0.0.1'
  return { baseUrl: `http://${host}:${port}`, key, dataDir, settings: value }
}

function readSettingsFile(dataDir = resolveDataDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

function serverIcon() {
  try {
    const svg = fs.readFileSync(path.join(PLUGIN_ROOT, 'icon.svg'))
    return [{
      src: `data:image/svg+xml;base64,${svg.toString('base64')}`,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    }]
  } catch {
    return undefined
  }
}

const ICONS = serverIcon()

const TOOLS = [
  {
    name: 'open_our_free_model_config',
    title: 'Our Free Model',
    description: 'Open the Our Free Model configuration panel in Codex. Use it to manage model visibility, add API-key provider accounts, test connections, and inspect the local gateway.',
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...(ICONS === undefined ? {} : { icons: ICONS }),
    _meta: {
      ui: { resourceUri: UI_RESOURCE_URI, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }] },
      'openai/toolInvocation/invoking': 'Opening configuration…',
      'openai/toolInvocation/invoked': 'Configuration ready',
    },
  },
  {
    name: 'list_free_models',
    description: 'List the models the local Our Free Model gateway currently serves. Use this to discover a model id before calling ask_free_model, or to check whether the gateway is running.',
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'ask_free_model',
    title: 'Ask a free model',
    description: 'Ask one model a single question and return its answer. Use this for a quick second opinion or a cheap sub-query without changing the current session model. The model must be one of the ids from list_free_models.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or instruction to send.' },
        model: { type: 'string', description: 'A model id from list_free_models. Omit to let the gateway pick its first available model.' },
        reasoning_effort: { type: 'string', description: 'Optional thinking depth, e.g. "low", "high". Only models that declare a menu accept it.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'gateway_status',
    title: 'Gateway status',
    description: 'Report whether the local Our Free Model gateway is running, where it listens, and how many models it serves.',
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'start_gateway',
    title: 'Start the local gateway',
    description: 'Start the local Our Free Model gateway in the background and write its provider block into Codex config.toml. Safe to call when it is already running.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'panel_snapshot',
    title: 'Read plugin configuration',
    description: 'Return the sidebar configuration snapshot, including masked account state and model visibility.',
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_update_settings',
    title: 'Update plugin settings',
    description: 'Update plugin-wide settings and model visibility.',
    inputSchema: {
      type: 'object',
      properties: { settings: { type: 'object' } },
      required: ['settings'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_set_model',
    title: 'Set model visibility',
    description: 'Enable or hide one model in the Codex model picker.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['modelId', 'enabled'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_save_provider',
    title: 'Save provider account',
    description: 'Create or update an API-key provider account.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: { type: 'string' },
        enabled: { type: 'boolean' },
        apiKey: { type: 'string' },
        baseUrl: { type: 'string' },
        models: { type: 'array', items: { type: 'string' } },
      },
      required: ['providerId'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_remove_provider',
    title: 'Remove provider account',
    description: 'Remove one configured provider account and its stored key.',
    inputSchema: {
      type: 'object',
      properties: { providerId: { type: 'string' } },
      required: ['providerId'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_test_provider',
    title: 'Test provider account',
    description: 'Test a provider account by reading its model listing without spending a generation.',
    inputSchema: {
      type: 'object',
      properties: { providerId: { type: 'string' } },
      required: ['providerId'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_discover_provider',
    title: 'Discover provider models',
    description: 'Read the live model listing for one configured provider account.',
    inputSchema: {
      type: 'object',
      properties: { providerId: { type: 'string' } },
      required: ['providerId'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'panel_refresh',
    title: 'Refresh model catalog',
    description: 'Refresh the free lane model catalog and rebuild the Codex model picker data.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'settings.read',
    title: 'Read plugin settings',
    description: 'Read the structured settings exposed on the plugin details page.',
    inputSchema: EMPTY_INPUT,
    outputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'object' },
        values: { type: 'object' },
        layout: { type: 'array' },
      },
      required: ['schema', 'values'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: APP_ONLY,
  },
  {
    name: 'settings.update',
    title: 'Update plugin settings',
    description: 'Update primitive plugin settings from the plugin details page.',
    inputSchema: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            exposeRegionModels: { type: 'boolean' },
            hideFreeModels: { type: 'boolean' },
            aggregateEnabled: { type: 'boolean' },
            defaultMaxTokens: { type: 'integer', minimum: 1024, maximum: 1000000 },
          },
          additionalProperties: false,
        },
      },
      required: ['set'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { values: { type: 'object' } },
      required: ['values'],
    },
    _meta: APP_ONLY,
  },
]

async function callGateway(pathname, { key, method = 'GET', body, timeoutMs = 180_000 } = {}) {
  const settings = readGatewaySettings()
  if (settings === null) {
    throw Object.assign(
      new Error('Our Free Model is not set up yet. Open its sidebar panel and choose "启动并配置网关".'),
      { code: 'GATEWAY_NOT_CONFIGURED' },
    )
  }
  let response
  try {
    response = await fetch(`${settings.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${settings.key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw Object.assign(
      new Error(`the local gateway did not answer: ${error?.message ?? error}`),
      { code: 'GATEWAY_UNAVAILABLE' },
    )
  }
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`the gateway returned a non-JSON response (${response.status})`)
  }
  if (!response.ok) {
    const message = parsed?.error?.message ?? parsed?.message ?? `HTTP ${response.status}`
    throw Object.assign(new Error(String(message)), {
      code: 'GATEWAY_HTTP',
      statusCode: response.status,
    })
  }
  return parsed
}

async function listModels() {
  const payload = await callGateway('/v1/models')
  return Array.isArray(payload?.data) ? payload.data : []
}

async function askModel({ prompt, model, reasoning_effort: effort }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('`prompt` must be a non-empty string')
  let selected = typeof model === 'string' ? model.trim() : ''
  if (selected === '') {
    const rows = await listModels()
    if (rows.length === 0) throw new Error('the gateway is running but serves no models right now')
    selected = rows[0].id
  }
  const payload = await callGateway('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: selected,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      ...(typeof effort === 'string' && effort !== '' ? { reasoning_effort: effort } : {}),
    },
  })
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text === '') {
    const failure = payload?.error?.message
    throw new Error(failure ? `the model returned no text: ${failure}` : 'the model returned no text')
  }
  return { model: selected, text }
}

async function healthReachable(settings = readGatewaySettings()) {
  if (settings === null) return false
  try {
    const response = await fetch(`${settings.baseUrl}/health`, { signal: AbortSignal.timeout(1800) })
    return response.ok
  } catch {
    return false
  }
}

let gatewayLaunch = null

/**
 * Ensure the service is live and Codex's managed provider block points at it.
 * The service is detached so it outlives this MCP process, which Codex may stop
 * when a plugin is reloaded.
 */
export async function ensureGateway({ dataDir = resolveDataDir() } = {}) {
  const existing = readGatewaySettings(dataDir)
  if (existing !== null && await healthReachable(existing)) {
    const configPath = writeProviderConfig({ baseUrl: existing.baseUrl, key: existing.key })
    return {
      alreadyRunning: true,
      baseUrl: existing.baseUrl,
      dataDir,
      configPath,
    }
  }
  if (gatewayLaunch !== null) return gatewayLaunch
  gatewayLaunch = (async () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const logFile = path.join(dataDir, 'gateway.log')
    const logFd = fs.openSync(logFile, 'a')
    const env = {
      ...process.env,
      COFM_HOME: dataDir,
      ...(process.env.CODEX_HOME === undefined ? {} : { CODEX_HOME: process.env.CODEX_HOME }),
    }
    let child
    try {
      child = spawn(process.execPath, [CLI_PATH, 'run'], {
        cwd: PLUGIN_ROOT,
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
      })
    } finally {
      fs.closeSync(logFd)
    }
    let spawnError
    child.once('error', error => { spawnError = error })
    child.unref()

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw new Error(`could not start the gateway: ${spawnError.message}`)
      const settings = readGatewaySettings(dataDir)
      if (settings !== null && await healthReachable(settings)) {
        const configPath = writeProviderConfig({ baseUrl: settings.baseUrl, key: settings.key })
        return {
          alreadyRunning: false,
          baseUrl: settings.baseUrl,
          dataDir,
          configPath,
          logFile,
        }
      }
      await new Promise(resolve => setTimeout(resolve, 350))
    }
    throw new Error(`the gateway did not become ready within 30 seconds; see ${logFile}`)
  })()
  try {
    return await gatewayLaunch
  } finally {
    gatewayLaunch = null
  }
}

async function panelSnapshot() {
  try {
    return await callGateway('/panel', { timeoutMs: 15_000 })
  } catch (error) {
    if (error?.code !== 'GATEWAY_NOT_CONFIGURED' && error?.code !== 'GATEWAY_UNAVAILABLE') throw error
    const dataDir = resolveDataDir()
    return offlinePanelSnapshot({
      settings: readSettingsFile(dataDir),
      version: SERVER_VERSION,
      dataDir,
    })
  }
}

function settingsSchema() {
  return {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable inference',
        description: 'Allow model requests through the local gateway.',
      },
      exposeRegionModels: {
        type: 'boolean',
        title: 'Show region-limited models',
        description: 'Keep models visible when the current network is region blocked.',
      },
      hideFreeModels: {
        type: 'boolean',
        title: 'Hide the free pool',
        description: 'Hide every model from the built-in anonymous free lane.',
      },
      aggregateEnabled: {
        type: 'boolean',
        title: 'Enable provider accounts',
        description: 'Show models from your configured API-key provider accounts.',
      },
      defaultMaxTokens: {
        type: 'integer',
        title: 'Default output limit',
        minimum: 1024,
        maximum: 1000000,
      },
    },
  }
}

function settingsValues(snapshot) {
  return {
    enabled: snapshot?.settings?.enabled !== false,
    exposeRegionModels: snapshot?.settings?.exposeRegionModels !== false,
    hideFreeModels: snapshot?.settings?.hideFreeModels === true,
    aggregateEnabled: snapshot?.settings?.aggregate?.enabled !== false,
    defaultMaxTokens: Number.isFinite(snapshot?.settings?.defaultMaxTokens)
      ? snapshot.settings.defaultMaxTokens
      : 32768,
  }
}

function settingsLayout() {
  return [{
    kind: 'group',
    title: 'Our Free Model',
    items: [
      { kind: 'property', property: 'enabled' },
      { kind: 'property', property: 'hideFreeModels' },
      { kind: 'property', property: 'aggregateEnabled' },
      { kind: 'property', property: 'exposeRegionModels' },
      { kind: 'property', property: 'defaultMaxTokens' },
      { kind: 'tool', tool: 'start_gateway' },
    ],
  }]
}

async function updatePrimitiveSettings(set) {
  if (set === null || typeof set !== 'object' || Array.isArray(set)) {
    throw new Error('`set` must be an object')
  }
  const patch = {}
  if (Object.hasOwn(set, 'enabled')) patch.enabled = set.enabled === true
  if (Object.hasOwn(set, 'exposeRegionModels')) patch.exposeRegionModels = set.exposeRegionModels === true
  if (Object.hasOwn(set, 'hideFreeModels')) patch.hideFreeModels = set.hideFreeModels === true
  if (Object.hasOwn(set, 'defaultMaxTokens')) patch.defaultMaxTokens = set.defaultMaxTokens
  if (Object.hasOwn(set, 'aggregateEnabled')) patch.aggregate = { enabled: set.aggregateEnabled === true }
  const response = await callGateway('/panel/settings', { method: 'POST', body: patch })
  return response.snapshot
}

async function startGatewayTool() {
  const started = await ensureGateway()
  const snapshot = await panelSnapshot()
  return {
    ...started,
    snapshot,
  }
}

async function callTool(name, args) {
  if (name === 'list_free_models') {
    const rows = await listModels()
    const lines = rows.map(row => {
      const window = Number.isFinite(row?.context_window) ? ` (context ${row.context_window})` : ''
      return `- ${row?.id}${window}`
    })
    return lines.length === 0
      ? 'The gateway is running but serves no models right now.'
      : `${rows.length} free model(s) available:\n${lines.join('\n')}`
  }
  if (name === 'ask_free_model') {
    const { model, text } = await askModel(args ?? {})
    return `[${model}]\n\n${text}`
  }
  if (name === 'gateway_status') {
    const settings = readGatewaySettings()
    if (settings === null) return 'Not set up: no gateway settings found. Open the Our Free Model sidebar panel to start it.'
    try {
      const rows = await listModels()
      return `Running at ${settings.baseUrl}, serving ${rows.length} model(s).`
    } catch (error) {
      return `Configured at ${settings.baseUrl}, but the gateway did not answer: ${error.message}`
    }
  }
  if (name === 'open_our_free_model_config') {
    const snapshot = await panelSnapshot()
    return {
      text: snapshot.gateway.running
        ? `Our Free Model is configured. ${snapshot.counts.enabledModels} model(s) are visible.`
        : 'Our Free Model is not running. Use the configuration panel to start and wire the gateway.',
      structuredContent: snapshot,
    }
  }
  if (name === 'start_gateway') {
    const result = await startGatewayTool()
    return {
      text: result.alreadyRunning
        ? `The gateway is already running at ${result.baseUrl}.`
        : `The gateway is running at ${result.baseUrl}. Provider configuration was written to ${result.configPath}.`,
      structuredContent: result,
    }
  }
  if (name === 'panel_snapshot') {
    const snapshot = await panelSnapshot()
    return { text: 'Configuration loaded.', structuredContent: snapshot }
  }
  if (name === 'panel_update_settings') {
    const result = await callGateway('/panel/settings', {
      method: 'POST',
      body: args?.settings ?? {},
    })
    return { text: 'Settings saved.', structuredContent: result }
  }
  if (name === 'panel_set_model') {
    const result = await callGateway('/panel/model', {
      method: 'POST',
      body: { modelId: args?.modelId, enabled: args?.enabled === true },
    })
    return { text: 'Model visibility updated.', structuredContent: result }
  }
  if (name === 'panel_save_provider') {
    const body = {
      providerId: args?.providerId,
      ...(args?.enabled === undefined ? {} : { enabled: args.enabled === true }),
      ...(args?.apiKey === undefined ? {} : { apiKey: args.apiKey }),
      ...(args?.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
      ...(args?.models === undefined ? {} : { models: args.models }),
    }
    const result = await callGateway('/panel/providers/save', { method: 'POST', body })
    return { text: 'Provider account saved.', structuredContent: result }
  }
  if (name === 'panel_remove_provider') {
    const result = await callGateway('/panel/providers/remove', {
      method: 'POST',
      body: { providerId: args?.providerId },
    })
    return { text: 'Provider account removed.', structuredContent: result }
  }
  if (name === 'panel_test_provider') {
    const result = await callGateway('/panel/providers/test', {
      method: 'POST',
      body: { providerId: args?.providerId },
      timeoutMs: 60_000,
    })
    return { text: result.result?.message ?? 'Provider test completed.', structuredContent: result }
  }
  if (name === 'panel_discover_provider') {
    const result = await callGateway('/panel/providers/discover', {
      method: 'POST',
      body: { providerId: args?.providerId },
      timeoutMs: 60_000,
    })
    return {
      text: result.models === null ? 'This provider declares no model listing.' : `Found ${result.models.length} model(s).`,
      structuredContent: result,
    }
  }
  if (name === 'panel_refresh') {
    const result = await callGateway('/panel/refresh', { method: 'POST', timeoutMs: 600_000 })
    return { text: 'Model catalog refreshed.', structuredContent: result }
  }
  if (name === 'settings.read') {
    const snapshot = await panelSnapshot()
    return {
      text: 'Settings loaded.',
      structuredContent: {
        schema: settingsSchema(),
        values: settingsValues(snapshot),
        layout: settingsLayout(),
      },
    }
  }
  if (name === 'settings.update') {
    const snapshot = await updatePrimitiveSettings(args?.set ?? {})
    return {
      text: 'Settings saved.',
      structuredContent: { values: settingsValues(snapshot) },
    }
  }
  throw new Error(`unknown tool "${name}"`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function capabilities() {
  const settings = {
    readTool: 'settings.read',
    updateTool: 'settings.update',
  }
  return {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    experimental: { 'openai/settings': settings },
    extensions: { 'openai/settings': settings },
  }
}

function serverInfo() {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    ...(ICONS === undefined ? {} : { icons: ICONS }),
  }
}

function panelResource(uri = UI_RESOURCE_URI) {
  return {
    uri,
    name: 'Our Free Model configuration',
    description: 'Configure free models, provider accounts, and the local gateway.',
    mimeType: 'text/html;profile=mcp-app',
  }
}

function readPanelResource(uri) {
  const html = fs.readFileSync(PANEL_HTML_PATH, 'utf8')
  return {
    contents: [{
      uri,
      mimeType: 'text/html;profile=mcp-app',
      text: html,
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        'openai/ui': {
          preferredDisplayMode: 'fullscreen',
          availableDisplayModes: ['inline', 'fullscreen'],
        },
        'openai/widgetDescription': 'Manage Our Free Model accounts and model visibility.',
      },
    }],
  }
}

async function handle(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null
  if (method === 'server/discover') {
    reply(id, {
      resultType: 'complete',
      supportedVersions: PROTOCOL_VERSIONS,
      capabilities: capabilities(),
      _meta: {
        'io.modelcontextprotocol/serverInfo': serverInfo(),
      },
    })
    return
  }
  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
    reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: capabilities(),
      serverInfo: serverInfo(),
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    try {
      const result = await callTool(name, params?.arguments ?? {})
      if (typeof result === 'string') {
        reply(id, { content: [{ type: 'text', text: result }], isError: false })
      } else {
        reply(id, {
          content: [{ type: 'text', text: result.text ?? 'OK' }],
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          isError: result.isError === true,
        })
      }
    } catch (error) {
      reply(id, { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true })
    }
    return
  }
  if (method === 'resources/list') {
    reply(id, { resources: [panelResource()] })
    return
  }
  if (method === 'resources/read') {
    const uri = typeof params?.uri === 'string' ? params.uri : UI_RESOURCE_URI
    if (uri !== UI_RESOURCE_URI) {
      replyError(id, -32602, `unknown resource "${uri}"`)
      return
    }
    try {
      reply(id, readPanelResource(uri))
    } catch (error) {
      replyError(id, -32603, String(error?.message ?? error))
    }
    return
  }
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  void handle(message).catch(error => {
    if (message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, String(error?.message ?? error))
    }
  })
})
input.on('close', () => process.exit(0))
