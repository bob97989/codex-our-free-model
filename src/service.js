/**
 * Service entry: one process that owns the free lane and the local gateway
 * Codex talks to.
 *
 * The split from the DSH build is deliberate. In DSH the plugin was *hosted* —
 * the harness owned the process, the settings page and the model picker, and
 * this code was a guest inside it. Codex has no in-process plugin API for
 * inference, so the same lane has to stand on its own: this module is the
 * process, and Codex reaches it over HTTP exactly like any other provider.
 *
 * Everything expensive (the runtime, the catalog cache, the store) lives in
 * `src/core`, which never imported a harness module in the first place.
 *
 * @module src/service.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelRuntime, createRuntimeStores } from './core/runtime.js'
import { ensureGatewayKey, startCodexGateway } from './codex-gateway.js'
import { createPanelController } from './panel-controller.js'
import { DATA_DIR_NAME } from './store.js'

export const PRODUCT = 'codex-our-free-model'
export const VERSION = '1.1.0'

/**
 * Where this service keeps its state.
 *
 * `COFM_HOME` wins so a test or a second instance can point somewhere else;
 * the default sits beside Codex's own home rather than inside it, because
 * Codex rewrites `~/.codex` freely and this data must outlive an upgrade.
 */
export function resolveDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.COFM_HOME === 'string' ? env.COFM_HOME.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''
    ? path.resolve(env.CODEX_HOME.trim())
    : path.join(home, '.codex')
  return path.join(codexHome, DATA_DIR_NAME)
}

/**
 * Boot the service.
 *
 * Creation order matters: the key has to be durable before the listener binds,
 * because the listener is what tells the caller which port it got, and a
 * caller that has to re-read the key after a restart would hand Codex a
 * different token than the one already written into `config.toml`.
 */
export async function startService({
  dataDir = resolveDataDir(),
  host = '127.0.0.1',
  port,
  logger = console,
  refresh = true,
} = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const stores = createRuntimeStores({ dataDir, logger })
  let listener
  let runtime
  let refreshTimer
  let stopped = false

  const persist = patch => {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist settings')
    }
  }

  try {
    const saved = stores.settings.get()
    const key = ensureGatewayKey(saved.forwardKey)
    const savedForward = saved.forward ?? {}
    const requestedPort = port ?? (Number.isInteger(savedForward.port) && savedForward.port >= 0 && savedForward.port <= 65535
      ? savedForward.port
      : 0)
    const bindHost = host ?? savedForward.host ?? '127.0.0.1'
    persist({
      forwardKey: key,
      forward: { ...savedForward, enabled: true, host: bindHost, port: requestedPort },
    })

    runtime = createModelRuntime({
      ...stores,
      logger,
      attributionUserAgent: `${PRODUCT}/${VERSION}`,
    })
    const panel = createPanelController({
      settings: stores.settings,
      runtime,
      version: VERSION,
      logger,
    })

    listener = await startCodexGateway({
      runtime,
      panel,
      config: () => {
        const value = stores.settings.get()
        const forward = value.forward ?? {}
        return {
          host: forward.host ?? bindHost,
          port: forward.port ?? requestedPort,
          enabled: value.enabled !== false && forward.enabled !== false,
          forwardKey: value.forwardKey,
        }
      },
      log: message => logger.warn?.(message),
    })

    // Persist the port actually bound, so the next start reuses it and the
    // `base_url` already written into Codex's config keeps resolving.
    if (listener.port !== requestedPort) {
      persist({ forward: { ...(stores.settings.get().forward ?? {}), port: listener.port } })
    }

    if (refresh) {
      void runtime.refreshCatalog({ probe: false }).catch(error => {
        logger.warn?.(`${PRODUCT}: catalog refresh failed (${error?.message ?? error})`)
      })
      // The lane's roster follows the upstream, so a long-lived process has to
      // re-ask rather than serve whatever it saw at boot.
      refreshTimer = setInterval(() => {
        if (stopped) return
        void runtime.refreshCatalog({ probe: false }).catch(error => {
          logger.warn?.(`${PRODUCT}: catalog refresh failed (${error?.message ?? error})`)
        })
      }, 6 * 60 * 60 * 1000)
      refreshTimer.unref?.()
    }

    return {
      product: PRODUCT,
      version: VERSION,
      dataDir,
      port: listener.port,
      host: listener.host,
      url: `http://${listener.host === '0.0.0.0' ? '127.0.0.1' : listener.host}:${listener.port}`,
      key,
      runtime,
      panel,
      stores,
      async close() {
        if (stopped) return
        stopped = true
        clearInterval(refreshTimer)
        await listener?.close()
        runtime?.dispose()
        stores.dispose()
      },
    }
  } catch (error) {
    await listener?.close().catch(() => {})
    runtime?.dispose()
    stores.dispose()
    throw error
  }
}
