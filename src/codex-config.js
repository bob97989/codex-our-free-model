/**
 * The Codex-facing provider block.
 *
 * Plugins cannot declare a model provider in `plugin.json`, so this remains the
 * one piece of installation state that has to live in Codex's own config.toml.
 * Keep the renderer and the marker parser here so the CLI and the sidebar app
 * cannot disagree about the block they own.
 *
 * @module src/codex-config.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT, VERSION } from './service.js'

export const PROVIDER_ID = 'our-free-model'
export const CATALOG_PATH = '/models/catalog'
export const BLOCK_BEGIN = '# >>> our-free-model (managed block — edits here are overwritten) >>>'
export const BLOCK_END = '# <<< our-free-model <<<'

export function codexHome(env = process.env, home = os.homedir()) {
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return configured !== '' ? path.resolve(configured) : path.join(home, '.codex')
}

/**
 * Install the block. Trailing separator comes from the block and the leading
 * one is added only when the file does not already end in a newline, so
 * `stripManagedBlock(upsertManagedBlock(contents))` is exactly `contents`.
 */
export function upsertManagedBlock(contents, block) {
  const start = contents.indexOf(BLOCK_BEGIN)
  if (start !== -1) {
    const end = contents.indexOf(BLOCK_END, start)
    if (end !== -1) {
      const after = end + BLOCK_END.length
      const rest = contents.slice(after)
      return contents.slice(0, start) + block + (rest.startsWith('\n') ? rest.slice(1) : rest)
    }
  }
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${contents === '' ? '' : '\n'}${block}`
}

/** Blank-line separated so the block cannot merge with a neighbouring table. */
export function renderManagedBlock({ baseUrl, key }) {
  return `${BLOCK_BEGIN}
# Written by ${PRODUCT} v${VERSION}. Regenerate with: cofm setup
#
# Free models, no account and no key. The gateway runs on this machine and
# speaks the Responses API, which is the only wire Codex accepts.

[model_providers.${PROVIDER_ID}]
name = "Our Free Model (free)"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = false
model_catalog_url = "${baseUrl}${CATALOG_PATH}"
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000

[model_providers.${PROVIDER_ID}.http_headers]
Authorization = "Bearer ${key}"
${BLOCK_END}
`
}

/** Remove our block, restoring the document to the byte level it had before. */
export function stripManagedBlock(contents) {
  const start = contents.indexOf(BLOCK_BEGIN)
  if (start === -1) return contents
  const end = contents.indexOf(BLOCK_END, start)
  if (end === -1) return contents
  let prefix = contents.slice(0, start)
  let suffix = contents.slice(end + BLOCK_END.length)
  // upsertManagedBlock always inserts one blank-line separator before the
  // block. Remove exactly that newline, not the caller's existing trailing
  // whitespace, so uninstall restores the byte-level document.
  if (prefix !== '' && prefix.endsWith('\n')) prefix = prefix.slice(0, -1)
  if (suffix.startsWith('\n')) suffix = suffix.slice(1)
  return prefix + suffix
}

export function readConfig(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw new Error(`could not read ${file}: ${error.message}`)
  }
}

export function writeConfig(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write through a temporary file so a crash cannot leave a half-written
  // config.toml behind — Codex refuses to start on one.
  const temp = `${file}.cofm-${process.pid}.tmp`
  fs.writeFileSync(temp, contents, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** Write the provider block without touching any other Codex configuration. */
export function writeProviderConfig({
  baseUrl,
  key,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (typeof baseUrl !== 'string' || !/^http:\/\//i.test(baseUrl)) {
    throw new Error('baseUrl must be an http URL')
  }
  if (typeof key !== 'string' || key === '') throw new Error('gateway key is missing')
  const file = path.join(codexHome(env, home), 'config.toml')
  const contents = upsertManagedBlock(readConfig(file), renderManagedBlock({ baseUrl, key }))
  writeConfig(file, contents)
  return file
}
