#!/usr/bin/env node
/**
 * Our Free Model — MCP server.
 *
 * This is the second way into the same lane. The gateway gives Codex the free
 * models *as models*; this server gives Codex the lane *as tools*, which
 * matters for the two things a second provider cannot express:
 *
 * - asking a free model a one-off question without switching the session's
 *   model, and
 * - listing what the lane currently serves, including whether the gateway is
 *   even up.
 *
 * It never imports the lane's request path. It talks to the running gateway
 * over HTTP, so an MCP tool call cannot hold a second copy of the runtime,
 * its stores or its quota accounting in memory.
 *
 * Transport is stdio with newline-delimited JSON-RPC, per the MCP spec.
 *
 * @module bin/mcp-server.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'codex-our-free-model'
const SERVER_VERSION = '1.0.0'

/** Mirrors `resolveDataDir` in src/service.js without importing the runtime. */
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
  return { baseUrl: `http://${host}:${port}`, key }
}

const TOOLS = [
  {
    name: 'list_free_models',
    description: 'List the free models the local Our Free Model gateway currently serves. Use this to discover a model id before calling ask_free_model, or to check whether the gateway is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_free_model',
    description: 'Ask one free frontier model a single question and return its answer. Use this for a quick second opinion or a cheap sub-query without changing the current session model. The model must be one of the ids from list_free_models.',
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
  },
  {
    name: 'gateway_status',
    description: 'Report whether the local Our Free Model gateway is running, where it listens, and how many models it serves. Use this to diagnose "the free provider does not work" before changing any configuration.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function callGateway(pathname, { key, method = 'GET', body } = {}) {
  const settings = readGatewaySettings()
  if (settings === null) {
    throw new Error('Our Free Model is not set up yet. Run `npx codex-our-free-model setup` (or `cofm setup`) to start the gateway and wire Codex to it.')
  }
  const response = await fetch(`${settings.baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${settings.key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`the gateway returned a non-JSON response (${response.status})`)
  }
  if (!response.ok) {
    const message = parsed?.error?.message ?? parsed?.message ?? `HTTP ${response.status}`
    throw new Error(String(message))
  }
  return parsed
}

async function listModels() {
  const payload = await callGateway('/v1/models')
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows
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
    if (settings === null) return 'Not set up: no gateway settings found. Run `cofm setup`.'
    try {
      const rows = await listModels()
      return `Running at ${settings.baseUrl}, serving ${rows.length} model(s).`
    } catch (error) {
      return `Configured at ${settings.baseUrl}, but the gateway did not answer: ${error.message}`
    }
  }
  throw new Error(`unknown tool "${name}"`)
}

// ---------------------------------------------------------------- JSON-RPC

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message
  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
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
      const text = await callTool(name, params?.arguments ?? {})
      reply(id, { content: [{ type: 'text', text }], isError: false })
    } catch (error) {
      // A tool failure is a result, not a protocol error: Codex shows the
      // message to the model and lets it recover.
      reply(id, { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true })
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
    // A malformed frame has no id to answer to; staying silent keeps the
    // stream parseable for every later message.
    return
  }
  void handle(message).catch(error => {
    if (message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, String(error?.message ?? error))
    }
  })
})
input.on('close', () => process.exit(0))