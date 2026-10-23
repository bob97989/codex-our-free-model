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
export const MODEL_CATALOG_RELATIVE_PATH = 'our-free-model/model-catalog.json'
export const BLOCK_BEGIN = '# >>> our-free-model (managed block — edits here are overwritten) >>>'
export const BLOCK_END = '# <<< our-free-model <<<'
export const FALLBACK_BASE_INSTRUCTIONS = 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.'

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Set top-level TOML values without touching tables. Codex requires provider
 * selection and the catalog path at the document root, while the managed
 * provider block lives later among the tables.
 */
export function setTopLevelValues(contents, values) {
  const rows = contents.split('\n')
  let firstTable = rows.findIndex(line => /^\s*\[/.test(line))
  if (firstTable === -1) firstTable = rows.length
  const top = rows.slice(0, firstTable)
  const rest = rows.slice(firstTable)
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
    const first = top.findIndex(line => pattern.test(line))
    const line = `${key} = ${JSON.stringify(value)}`
    if (first === -1) {
      top.push(line)
    } else {
      top[first] = line
      for (let index = top.length - 1; index > first; index -= 1) {
        if (pattern.test(top[index])) top.splice(index, 1)
      }
    }
  }
  while (top.length > 0 && top.at(-1).trim() === '') top.pop()
  if (rest.length > 0) top.push('')
  return [...top, ...rest].join('\n')
}

/** Enable or disable one key in the root `[features]` table. */
export function setFeature(contents, feature, enabled = true) {
  const rows = contents.split('\n')
  let section = rows.findIndex(line => /^\s*\[features\]\s*$/.test(line))
  if (section === -1) {
    while (rows.length > 0 && rows.at(-1).trim() === '') rows.pop()
    if (rows.length > 0) rows.push('')
    rows.push('[features]', `${feature} = ${enabled === true}`)
    return `${rows.join('\n')}\n`
  }
  let end = rows.length
  for (let index = section + 1; index < rows.length; index += 1) {
    if (/^\s*\[/.test(rows[index])) {
      end = index
      break
    }
  }
  const pattern = new RegExp(`^\\s*${escapeRegExp(feature)}\\s*=`)
  const existing = rows.findIndex((line, index) => index > section && index < end && pattern.test(line))
  if (existing === -1) rows.splice(section + 1, 0, `${feature} = ${enabled === true}`)
  else rows[existing] = `${feature} = ${enabled === true}`
  return rows.join('\n')
}

/** Write the Codex-native model catalog used by the desktop model picker. */
export function writeModelCatalog(file, models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('model catalog must be a non-empty array')
  }
  const normalized = models.map(model => ({
    ...model,
    base_instructions: typeof model?.base_instructions === 'string' && model.base_instructions !== ''
      ? model.base_instructions
      : FALLBACK_BASE_INSTRUCTIONS,
  }))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ models: normalized }, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
  return file
}

/**
 * Write the provider block and, when catalog rows are supplied, select this
 * provider in Codex and install a local catalog. The local file is needed by
 * Codex builds whose picker does not refresh `model_catalog_url` at startup.
 */
export function writeProviderConfig({
  baseUrl,
  key,
  models,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (typeof baseUrl !== 'string' || !/^http:\/\//i.test(baseUrl)) {
    throw new Error('baseUrl must be an http URL')
  }
  if (typeof key !== 'string' || key === '') throw new Error('gateway key is missing')
  const root = codexHome(env, home)
  const file = path.join(root, 'config.toml')
  let contents = upsertManagedBlock(readConfig(file), renderManagedBlock({ baseUrl, key }))
  contents = setFeature(contents, 'enable_mcp_apps', true)
  if (Array.isArray(models) && models.length > 0) {
    writeModelCatalog(path.join(root, MODEL_CATALOG_RELATIVE_PATH), models)
    const first = typeof models[0]?.slug === 'string' && models[0].slug !== '' ? models[0].slug : PROVIDER_ID
    contents = setTopLevelValues(contents, {
      model: first,
      model_provider: PROVIDER_ID,
      model_catalog_json: MODEL_CATALOG_RELATIVE_PATH,
    })
  }
  writeConfig(file, contents)
  return file
}
