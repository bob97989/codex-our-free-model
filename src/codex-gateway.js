/**
 * The Codex-facing gateway.
 *
 * Codex speaks exactly one inference wire — the Responses API at
 * `/v1/responses` (`WireApi` has a single variant, `Responses`; `chat` is
 * rejected at config-parse time). It reaches a custom provider through
 * `[model_providers.<id>]` in `~/.codex/config.toml`, and it will pull the
 * provider's *model roster* from `model_catalog_url` when one is configured.
 *
 * Those two facts decide this module's whole shape:
 *
 * - `/v1/responses` is served from the free lane's existing Responses
 *   implementation (`src/forward.js`), so Codex gets real streaming, real tool
 *   calls and real usage rather than a translation shim.
 * - The catalog endpoint is what puts free models *in Codex's own picker*. The
 *   roster is re-derived from the live lane on every ask, so a model the
 *   upstream adds shows up without this plugin shipping an update.
 *
 * `/v1/chat/completions` and `/v1/messages` stay mounted as well: other local
 * tools (and the `ask_model` MCP tool) reach the same lane, and dropping them
 * would make the gateway useful to Codex alone for no gain.
 *
 * @module src/codex-gateway.js
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { startForwardServer, generateKey, rankLanAddresses } from './forward.js'

/** Codex caps a downloaded provider catalog at 1 MiB; stay far under it. */
export const MAX_CATALOG_BYTES = 512 * 1024

/** The default model window when the lane declares nothing better. */
const DEFAULT_CONTEXT_WINDOW = 272_000

/**
 * Reason the catalog exists at all: Codex asks a custom provider for its
 * roster. `supported_reasoning_levels` is left empty on purpose — the lane
 * declares its own effort menus per model, and advertising a Codex-side menu
 * the upstream would reject is worse than advertising none.
 *
 * @param {{id: string, displayName?: string, contextWindow?: number, maxOutput?: number, description?: string}} row
 * @param {number} priority
 */
export function codexCatalogEntry(row, priority) {
  const contextWindow = Number.isFinite(row.contextWindow) && row.contextWindow > 0
    ? Math.trunc(row.contextWindow)
    : DEFAULT_CONTEXT_WINDOW
  return {
    slug: row.id,
    display_name: row.displayName && row.displayName !== '' ? row.displayName : row.id,
    description: row.description ?? `Free model via Our Free Model (${row.id})`,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    default_reasoning_summary: 'none',
    supports_reasoning_summaries: false,
    support_verbosity: false,
    shell_type: 'shell_command',
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    input_modalities: ['text'],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
    experimental_supported_tools: [],
    service_tiers: [],
    additional_speed_tiers: [],
    availability_nux: null,
    priority,
    visibility: 'list',
    supported_in_api: true,
    upgrade: null,
  }
}

/**
 * Project the live roster into Codex's catalog document.
 *
 * Slugs must be unique and non-empty or Codex rejects the whole catalog, and
 * the lane's own listing is not guaranteed free of either, so the projection
 * filters rather than trusts. Region-blocked models are included: a catalog is
 * a roster, not a verdict, and hiding a model here would make it unreachable
 * even after the egress changes.
 *
 * @param {Array<object>} rows - rows from `runtime.publicModelRows()`
 */
export function buildCodexCatalog(rows) {
  const seen = new Set()
  const models = []
  let priority = 1
  for (const row of rows ?? []) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    models.push(codexCatalogEntry({ ...row, id }, priority++))
  }
  return { models }
}

/** Constant-time comparison, so a probing caller cannot time-walk the key. */
function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected === '') return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function bearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') {
    const apiKey = req.headers['x-api-key']
    return typeof apiKey === 'string' ? apiKey : undefined
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read one bounded JSON request body from the loopback settings API. */
async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      throw Object.assign(new Error('request body is too large'), { statusCode: 413 })
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 })
  }
}

function errorMessage(error) {
  return String(error?.message ?? error)
}

/**
 * The settings endpoints. Every route is behind the same bearer key as the
 * model catalog; the sidebar reaches them through the MCP server, not directly
 * from its sandboxed iframe.
 */
async function handlePanelRequest(req, res, path, panel) {
  if (!path.startsWith('/panel')) return false
  try {
    if (req.method === 'GET' && path === '/panel') {
      sendJson(res, 200, panel.snapshot())
      return true
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { message: `no settings route for ${req.method} ${path}` } })
      return true
    }
    const body = await readJson(req)
    if (path === '/panel/settings') {
      sendJson(res, 200, { ok: true, snapshot: panel.updateSettings(body) })
      return true
    }
    if (path === '/panel/model') {
      sendJson(res, 200, { ok: true, snapshot: panel.setModelEnabled(body) })
      return true
    }
    if (path === '/panel/providers/save') {
      sendJson(res, 200, { ok: true, snapshot: panel.saveProvider(body) })
      return true
    }
    if (path === '/panel/providers/remove') {
      sendJson(res, 200, { ok: true, snapshot: panel.removeProvider(body?.providerId) })
      return true
    }
    if (path === '/panel/providers/test') {
      sendJson(res, 200, { ok: true, ...await panel.testProviderAccount(body?.providerId) })
      return true
    }
    if (path === '/panel/providers/discover') {
      sendJson(res, 200, { ok: true, ...await panel.discoverProviderModels(body?.providerId) })
      return true
    }
    if (path === '/panel/refresh') {
      sendJson(res, 200, { ok: true, snapshot: await panel.refreshModels() })
      return true
    }
    sendJson(res, 404, { error: { message: `unknown settings route ${path}` } })
  } catch (error) {
    const status = Number(error?.statusCode)
    sendJson(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, {
      error: { message: errorMessage(error) },
    })
  }
  return true
}

/**
 * Start the gateway Codex talks to.
 *
 * @param {object} options
 * @param {object} options.runtime - the model runtime from `src/core/runtime.js`
 * @param {object} options.panel - settings controller from `src/panel-controller.js`
 * @param {() => {enabled?: boolean, host?: string, port?: number, forwardKey?: string}} options.config
 * @param {(message: string) => void} [options.log]
 */
export async function startCodexGateway({ runtime, panel, config, log = () => {} }) {
  const settings = () => config() ?? {}
  const key = () => {
    const value = settings().forwardKey
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /**
   * Handled before the free lane's own router sees the request.
   *
   * `/v1/models` and the catalog route deliberately sit behind the key check:
   * they describe the user's roster, and the lane's key is the only
   * authorization this port has. Codex sends the provider's bearer token on
   * every request, catalog fetch included, so this costs it nothing.
   */
  const handleRequest = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === '/panel' || path.startsWith('/panel/')) {
      if (!keyMatches(bearer(req), key())) {
        sendJson(res, 401, { error: { message: 'missing or invalid API key', type: 'invalid_request_error' } })
        return true
      }
      return handlePanelRequest(req, res, path, panel)
    }
    const catalogPaths = new Set(['/models/catalog', '/v1/models/catalog'])
    if (!catalogPaths.has(path) && path !== '/v1/models' && path !== '/models') return false
    if (req.method !== 'GET') return false
    if (!keyMatches(bearer(req), key())) {
      sendJson(res, 401, { error: { message: 'missing or invalid API key', type: 'invalid_request_error' } })
      return true
    }
    if (catalogPaths.has(path)) {
      const catalog = buildCodexCatalog(runtime.publicModelRows())
      if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES) {
        log('catalog exceeded the Codex size budget; serving an empty roster')
        sendJson(res, 200, { models: [] })
        return true
      }
      sendJson(res, 200, catalog)
      return true
    }
    // The free lane's own router answers this one identically; claiming it here
    // keeps every roster route on one code path.
    sendJson(res, 200, { object: 'list', data: runtime.publicModelRows() })
    return true
  }

  const listener = await startForwardServer({
    config: () => ({
      host: settings().host ?? '127.0.0.1',
      port: Number.isFinite(Number(settings().port)) ? Number(settings().port) : 0,
      enabled: settings().enabled !== false,
      key: key(),
    }),
    complete: runtime.complete,
    modelRows: runtime.publicModelRows,
    log: message => log(`gateway: ${message}`),
    health: () => ({
      ok: true,
      service: 'codex-our-free-model',
      models: runtime.publicModelRows().length,
      catalog: '/models/catalog',
    }),
    handleRequest,
  })

  return listener
}

/** The key the gateway expects, minted once and persisted by the caller. */
export function ensureGatewayKey(existing) {
  return typeof existing === 'string' && existing !== '' ? existing : generateKey()
}

export { rankLanAddresses, generateKey }
