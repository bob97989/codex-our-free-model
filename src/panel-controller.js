/**
 * The settings surface shared by the local gateway and the sidebar MCP App.
 *
 * The browser never reads the settings file and never receives an API key.
 * Every mutation crosses the authenticated loopback gateway, which owns the
 * JsonStore and can rebuild the model catalog before answering.
 *
 * @module src/panel-controller.js
 */

import { ROUTE_MAIN, ROUTE_REGION } from './adapter.js'
import { fetchProviderModels, testProvider } from './aggregate.js'
import { getProvider, listProviders } from './providers/index.js'
import {
  SETTINGS_INITIAL,
  isModelHidden,
  publicModelVisibility,
  validateModelVisibility,
} from './store.js'

const MAX_MODELS = 300
const MAX_MODEL_ID_LENGTH = 300
const MAX_BASE_URL_LENGTH = 512
const MAX_API_KEY_LENGTH = 512
const MAX_TEST_MESSAGE_LENGTH = 500

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function stringList(value, maxLength = MAX_MODELS) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const rows = []
  for (const raw of value) {
    const id = cleanString(raw, MAX_MODEL_ID_LENGTH)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    rows.push(id)
    if (rows.length >= maxLength) break
  }
  return rows
}

/** The provider registry, compact enough for one settings page to hold. */
export function publicProviderRegistry() {
  return listProviders().map(provider => ({
    id: provider.id,
    name: provider.name,
    category: provider.category,
    authKind: provider.auth?.kind ?? 'apiKey',
    credentialUrl: provider.auth?.url ?? '',
    baseUrl: provider.baseUrl ?? '',
    baseUrlOverrideEnv: provider.baseUrlOverrideEnv ?? '',
    format: provider.format,
    website: provider.website ?? '',
    notes: provider.notes ?? '',
    local: provider.local === true,
    modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
    models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      vision: model.vision === true,
      reasoning: model.reasoning === true,
    })),
  }))
}

/**
 * The aggregate section with each credential replaced by a recognisable hint.
 * The value itself stays in the 0600 settings file.
 */
export function publicAggregate(section) {
  const providers = isRecord(section?.providers) ? section.providers : {}
  const out = {}
  for (const [id, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue
    const key = typeof value.apiKey === 'string' ? value.apiKey : ''
    out[id] = {
      enabled: value.enabled !== false,
      hasKey: key !== '',
      keyHint: key === '' ? '' : `…${key.slice(-4)}`,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      models: stringList(value.models),
      discovered: stringList(value.discovered),
      addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
      lastTest: isRecord(value.lastTest) ? {
        at: Number.isFinite(value.lastTest.at) ? value.lastTest.at : 0,
        ok: value.lastTest.ok === true,
        status: Number.isFinite(value.lastTest.status) ? value.lastTest.status : 0,
        message: cleanString(value.lastTest.message, MAX_TEST_MESSAGE_LENGTH),
      } : null,
    }
  }
  return { enabled: section?.enabled !== false, providers: out }
}

export function publicPanelSettings(settings) {
  return {
    ...publicModelVisibility(settings),
    enabled: settings?.enabled !== false,
    exposeRegionModels: settings?.exposeRegionModels !== false,
    defaultMaxTokens: Number.isFinite(settings?.defaultMaxTokens) ? settings.defaultMaxTokens : 32768,
    aggregate: publicAggregate(settings?.aggregate),
  }
}

function gatewayFromSettings(settings, version) {
  const forward = settings?.forward ?? {}
  const port = Number(forward.port)
  const key = typeof settings?.forwardKey === 'string' ? settings.forwardKey : ''
  const host = typeof forward.host === 'string' && forward.host !== '0.0.0.0'
    ? forward.host
    : '127.0.0.1'
  return {
    configured: Number.isInteger(port) && port > 0 && key !== '',
    running: true,
    url: Number.isInteger(port) && port > 0 ? `http://${host}:${port}` : '',
    port: Number.isInteger(port) ? port : 0,
    version,
  }
}

function accountRows(aggregate, catalog) {
  return Object.entries(aggregate.providers).map(([id, state]) => {
    const provider = getProvider(id)
    return {
      providerId: id,
      name: provider?.name ?? id,
      format: provider?.format ?? '',
      category: provider?.category ?? '',
      credentialUrl: provider?.auth?.url ?? '',
      ...state,
      contributedModels: catalog.filter(entry => entry.channel === 'aggregate' && entry.providerId === id).length,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}

function modelRows(runtime, settings) {
  const snapshot = runtime.state()
  const main = new Set(snapshot.membership?.[ROUTE_MAIN] ?? [])
  const region = new Set(snapshot.membership?.[ROUTE_REGION] ?? [])
  return snapshot.catalog.map(entry => {
    const hiddenByGroup = isModelHidden(entry, { ...settings, hiddenModelIds: [] })
    const hidden = isModelHidden(entry, settings)
    return {
      id: entry.id,
      name: entry.name || entry.id,
      channel: entry.channel ?? 'free',
      providerId: entry.providerId ?? '',
      modelId: entry.modelId ?? entry.id,
      enabled: !hidden,
      hiddenByGroup,
      contextWindow: entry.contextWindow ?? null,
      maxOutput: entry.maxOutput ?? null,
      vision: entry.vision === true,
      reasoning: entry.reasoning === true,
      source: entry.source ?? '',
      route: main.has(entry.id) ? 'main' : region.has(entry.id) ? 'region' : null,
    }
  }).sort((left, right) => {
    const leftFree = left.channel === 'free' ? 0 : 1
    const rightFree = right.channel === 'free' ? 0 : 1
    return leftFree - rightFree || left.name.localeCompare(right.name)
  })
}

function panelSnapshot({ settings, runtime, version }) {
  const value = settings.get()
  const publicSettings = publicPanelSettings(value)
  const models = modelRows(runtime, value)
  const accounts = accountRows(publicSettings.aggregate, runtime.catalog)
  return {
    version,
    gateway: gatewayFromSettings(value, version),
    settings: publicSettings,
    models,
    accounts,
    registry: publicProviderRegistry(),
    counts: {
      models: models.length,
      enabledModels: models.filter(model => model.enabled).length,
      freeModels: models.filter(model => model.channel === 'free').length,
      aggregateModels: models.filter(model => model.channel === 'aggregate').length,
      accounts: accounts.length,
    },
  }
}

/**
 * A read-only view used while the gateway is not running. It deliberately has
 * no invented model list: account state is useful, model availability is not.
 */
export function offlinePanelSnapshot({ settings, version, dataDir }) {
  const merged = {
    ...structuredClone(SETTINGS_INITIAL),
    ...(isRecord(settings) ? settings : {}),
  }
  const value = publicPanelSettings(merged)
  const forward = merged.forward ?? {}
  const port = Number(forward.port)
  const configured = Number.isInteger(port) && port > 0
    && typeof merged.forwardKey === 'string' && merged.forwardKey !== ''
  return {
    version,
    gateway: {
      configured,
      running: false,
      url: configured ? `http://${forward.host && forward.host !== '0.0.0.0' ? forward.host : '127.0.0.1'}:${port}` : '',
      port: configured ? port : 0,
      version,
      dataDir,
    },
    settings: value,
    models: [],
    accounts: accountRows(value.aggregate, []),
    registry: publicProviderRegistry(),
    counts: {
      models: 0,
      enabledModels: 0,
      freeModels: 0,
      aggregateModels: 0,
      accounts: Object.keys(value.aggregate.providers).length,
    },
  }
}

export function createPanelController({
  settings,
  runtime,
  version = '1.0.0',
  logger = console,
}) {
  if (settings === undefined || runtime === undefined) {
    throw new TypeError('settings and runtime are required')
  }

  const snapshot = () => panelSnapshot({ settings, runtime, version })

  const commit = patch => {
    const previous = settings.get()
    settings.update(patch)
    settings.flush()
    if (settings.writeFailed) {
      settings.value = previous
      throw httpError(500, 'could not persist settings')
    }
    return settings.get()
  }

  const updateSettings = patch => {
    if (!isRecord(patch)) throw httpError(400, 'settings must be a JSON object')
    const current = settings.get()
    const next = { ...current }
    for (const key of ['enabled', 'exposeRegionModels']) {
      if (Object.hasOwn(patch, key)) {
        if (typeof patch[key] !== 'boolean') throw httpError(400, `${key} must be a boolean`)
        next[key] = patch[key]
      }
    }
    if (Object.hasOwn(patch, 'defaultMaxTokens')) {
      const tokens = Number(patch.defaultMaxTokens)
      if (!Number.isInteger(tokens) || tokens < 1024 || tokens > 1_000_000) {
        throw httpError(400, 'defaultMaxTokens must be an integer between 1024 and 1000000')
      }
      next.defaultMaxTokens = tokens
    }
    Object.assign(next, validateModelVisibility(patch))
    if (patch.aggregate !== undefined) {
      if (!isRecord(patch.aggregate)) throw httpError(400, 'aggregate must be a JSON object')
      if (patch.aggregate.enabled !== undefined && typeof patch.aggregate.enabled !== 'boolean') {
        throw httpError(400, 'aggregate.enabled must be a boolean')
      }
      next.aggregate = {
        ...(current.aggregate ?? {}),
        ...(patch.aggregate.enabled === undefined ? {} : { enabled: patch.aggregate.enabled }),
      }
    }
    commit(next)
    if (patch.aggregate !== undefined) runtime.syncAggregateCatalog()
    return snapshot()
  }

  const setModelEnabled = ({ modelId, enabled }) => {
    const id = cleanString(modelId, MAX_MODEL_ID_LENGTH)
    if (id === '') throw httpError(400, 'modelId is required')
    if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean')
    const hidden = stringList(settings.get().hiddenModelIds, 1000).filter(candidate => candidate !== id)
    if (!enabled) hidden.push(id)
    commit({ hiddenModelIds: hidden })
    return snapshot()
  }

  const saveProvider = patch => {
    if (!isRecord(patch)) throw httpError(400, 'provider settings must be a JSON object')
    const id = cleanString(patch.providerId, 200)
    const provider = getProvider(id)
    if (provider === null) throw httpError(400, `unknown provider "${id}"`)
    if (provider.auth?.kind === 'oauth' || provider.auth?.kind === 'adc') {
      throw httpError(400, `"${provider.name}" uses ${provider.auth.kind}; the aggregate lane only stores API keys`)
    }

    const current = settings.get()
    const section = isRecord(current.aggregate) ? current.aggregate : {}
    const providers = isRecord(section.providers) ? { ...section.providers } : {}
    const previous = isRecord(providers[id]) ? providers[id] : {}
    const next = {
      ...previous,
      enabled: patch.enabled === undefined ? previous.enabled !== false : patch.enabled === true,
      addedAt: Number.isFinite(previous.addedAt) && previous.addedAt > 0 ? previous.addedAt : Date.now(),
    }
    if (Object.hasOwn(patch, 'apiKey')) {
      if (typeof patch.apiKey !== 'string') throw httpError(400, 'apiKey must be a string')
      next.apiKey = patch.apiKey.trim().slice(0, MAX_API_KEY_LENGTH)
      next.lastTest = null
    }
    if (Object.hasOwn(patch, 'baseUrl')) {
      if (typeof patch.baseUrl !== 'string') throw httpError(400, 'baseUrl must be a string')
      const baseUrl = patch.baseUrl.trim().slice(0, MAX_BASE_URL_LENGTH)
      if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
        throw httpError(400, 'baseUrl must be an http(s) URL')
      }
      next.baseUrl = baseUrl
      next.lastTest = null
    }
    if (Object.hasOwn(patch, 'models')) {
      if (!Array.isArray(patch.models)) throw httpError(400, 'models must be an array')
      next.models = stringList(patch.models)
    }
    providers[id] = next
    commit({
      aggregate: {
        ...section,
        enabled: section.enabled !== false,
        providers,
      },
    })
    runtime.syncAggregateCatalog()
    return snapshot()
  }

  const removeProvider = providerId => {
    const id = cleanString(providerId, 200)
    if (id === '') throw httpError(400, 'providerId is required')
    const current = settings.get()
    const section = isRecord(current.aggregate) ? current.aggregate : {}
    const providers = isRecord(section.providers) ? { ...section.providers } : {}
    if (!Object.hasOwn(providers, id)) return snapshot()
    delete providers[id]
    commit({ aggregate: { ...section, providers } })
    runtime.syncAggregateCatalog()
    return snapshot()
  }

  const testProviderAccount = async providerId => {
    const id = cleanString(providerId, 200)
    const provider = getProvider(id)
    if (provider === null) throw httpError(400, `unknown provider "${id}"`)
    const result = await testProvider(settings.get().aggregate ?? {}, id)
    const current = settings.get()
    const section = isRecord(current.aggregate) ? current.aggregate : {}
    const providers = isRecord(section.providers) ? { ...section.providers } : {}
    if (isRecord(providers[id])) {
      providers[id] = {
        ...providers[id],
        lastTest: {
          at: Date.now(),
          ok: result.ok === true,
          status: result.status ?? 0,
          message: cleanString(result.message, MAX_TEST_MESSAGE_LENGTH),
        },
      }
      commit({ aggregate: { ...section, providers } })
    }
    return { result, snapshot: snapshot() }
  }

  const discoverProviderModels = async providerId => {
    const id = cleanString(providerId, 200)
    const provider = getProvider(id)
    if (provider === null) throw httpError(400, `unknown provider "${id}"`)
    const models = await fetchProviderModels(settings.get().aggregate ?? {}, id)
    if (models === null) return { models: null, snapshot: snapshot() }
    const current = settings.get()
    const section = isRecord(current.aggregate) ? current.aggregate : {}
    const providers = isRecord(section.providers) ? { ...section.providers } : {}
    if (isRecord(providers[id])) {
      providers[id] = { ...providers[id], discovered: stringList(models) }
      commit({ aggregate: { ...section, providers } })
      runtime.syncAggregateCatalog()
    }
    return { models, snapshot: snapshot() }
  }

  const refreshModels = async () => {
    try {
      await runtime.refreshCatalog({ probe: false, force: true })
    } catch (error) {
      logger.warn?.(`our-free-model: manual catalog refresh failed (${error?.message ?? error})`)
      throw error
    }
    return snapshot()
  }

  return {
    snapshot,
    updateSettings,
    setModelEnabled,
    saveProvider,
    removeProvider,
    testProviderAccount,
    discoverProviderModels,
    refreshModels,
  }
}
