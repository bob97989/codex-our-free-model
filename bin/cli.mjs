#!/usr/bin/env node
/**
 * `cofm` — setup, doctor and run.
 *
 * The only genuinely hard part of this plugin is the one Codex cannot do for
 * itself: a plugin manifest describes skills, MCP servers and hooks, but *not*
 * model providers. A provider is `~/.codex/config.toml`, so something has to
 * write it, and it has to write it without destroying the rest of a file the
 * user (and several other tools, this machine included) already edit.
 *
 * So this command reads the existing TOML, replaces exactly the blocks it owns,
 * and leaves every other byte — comments included — where it found it.
 *
 * @module bin/cli.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService, resolveDataDir, PRODUCT, VERSION } from '../src/service.js'

const PROVIDER_ID = 'our-free-model'
const CATALOG_PATH = '/models/catalog'
const BEGIN = '# >>> our-free-model (managed block — edits here are overwritten) >>>'
const END = '# <<< our-free-model <<<'

function codexHome(env = process.env) {
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.codex')
}

/**
 * Install the block. Trailing separator comes from the block and the leading
 * one is added only when the file does not already end in a newline, so
 * `stripManagedBlock(upsert(contents))` is exactly `contents`.
 */
export function upsertManagedBlock(contents, block) {
  const start = contents.indexOf(BEGIN)
  if (start !== -1) {
    const end = contents.indexOf(END, start)
    if (end !== -1) {
      const after = end + END.length
      const rest = contents.slice(after)
      // Drop the newline immediately after the old block, then let the (also
      // newline-terminated) replacement supply exactly one.
      return contents.slice(0, start) + block + (rest.startsWith('\n') ? rest.slice(1) : rest)
    }
  }
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${contents === '' ? '' : '\n'}${block}`
}

/** Blank-line separated so the block cannot merge with a neighbouring table. */
export function renderManagedBlock({ baseUrl, key }) {
  return `${BEGIN}
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
${END}
`
}

/**
 * Remove our block, restoring the document to the byte level it had before
 * `upsertManagedBlock` ran. Absent block is a no-op.
 */
export function stripManagedBlock(contents) {
  const start = contents.indexOf(BEGIN)
  if (start === -1) return contents
  const end = contents.indexOf(END, start)
  if (end === -1) return contents
  return contents.slice(0, start) + contents.slice(end + END.length)
}

function readConfig(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw new Error(`could not read ${file}: ${error.message}`)
  }
}

function writeConfig(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write through a temporary file so a crash cannot leave a half-written
  // config.toml behind — Codex refuses to start on one.
  const temp = `${file}.cofm-${process.pid}.tmp`
  fs.writeFileSync(temp, contents, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** Probe the gateway the way Codex will, so setup fails loudly, not later. */
async function verifyGateway({ baseUrl, key }) {
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
  if (!health.ok) throw new Error(`health check returned HTTP ${health.status}`)
  const catalog = await fetch(`${baseUrl}${CATALOG_PATH}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!catalog.ok) throw new Error(`catalog returned HTTP ${catalog.status}`)
  const body = await catalog.json()
  const models = Array.isArray(body?.models) ? body.models : []
  if (models.length === 0) throw new Error('the catalog was empty')
  return models
}

async function cmdSetup(argv) {
  const noConfig = argv.includes('--no-config')
  const portFlag = argv.indexOf('--port')
  const port = portFlag !== -1 ? Number(argv[portFlag + 1]) : undefined
  if (portFlag !== -1 && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error('--port must be an integer between 0 and 65535')
  }

  const service = await startService({ port })
  const { url, key } = service
  try {
    const models = await verifyGateway({ baseUrl: url, key })
    process.stdout.write(`Gateway listening on ${url}\nServing ${models.length} free model(s).\n`)
    if (noConfig) {
      process.stdout.write('\n--no-config given; config.toml was not touched.\n')
    } else {
      const file = path.join(codexHome(), 'config.toml')
      const next = upsertManagedBlock(readConfig(file), renderManagedBlock({ baseUrl: url, key }))
      writeConfig(file, next)
      process.stdout.write(`\nWrote [model_providers.${PROVIDER_ID}] into ${file}\n`)
    }
    process.stdout.write(
      `\nNext:\n` +
      `  1. Keep this process running (or run \`cofm run\` in the background).\n` +
      `  2. Start Codex and pick a model from the "Our Free Model" provider:\n` +
      `       codex -m ${models[0]?.slug ?? '<model>'} -c model_provider=${PROVIDER_ID}\n` +
      `     or set it permanently in config.toml:\n` +
      `       model_provider = "${PROVIDER_ID}"\n` +
      `       model = "${models[0]?.slug ?? '<model>'}"\n`,
    )
    // Setup leaves the gateway running: Codex is about to need it, and asking
    // the user to start a second process would be the whole setup step again.
    process.stdout.write('\nGateway is running. Press Ctrl+C to stop.\n')
    await new Promise(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await service.close()
  }
}

async function cmdRun(argv) {
  const portFlag = argv.indexOf('--port')
  const port = portFlag !== -1 ? Number(argv[portFlag + 1]) : undefined
  const service = await startService({ port })
  process.stdout.write(`${PRODUCT} ${VERSION}\nGateway: ${service.url}\nData:    ${service.dataDir}\n`)
  await new Promise(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await service.close()
}

async function cmdDoctor() {
  const results = []
  const note = (ok, label, detail) => results.push({ ok, label, detail })

  const file = path.join(codexHome(), 'config.toml')
  const contents = readConfig(file)
  const hasBlock = contents.includes(BEGIN)
  note(hasBlock, 'config.toml provider block', hasBlock ? `present in ${file}` : `missing — run \`cofm setup\``)

  const dataDir = resolveDataDir()
  const settingsFile = path.join(dataDir, 'settings.json')
  let settings = null
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    note(true, 'gateway settings', settingsFile)
  } catch (error) {
    note(false, 'gateway settings', error.code === 'ENOENT' ? `not created yet (${settingsFile})` : error.message)
  }

  const forward = settings?.forward ?? {}
  const baseUrl = `http://${forward.host === '0.0.0.0' ? '127.0.0.1' : forward.host ?? '127.0.0.1'}:${forward.port}`
  if (settings?.forwardKey && Number.isInteger(forward.port)) {
    try {
      const models = await verifyGateway({ baseUrl, key: settings.forwardKey })
      note(true, 'gateway reachable', `${baseUrl} — ${models.length} model(s)`)
    } catch (error) {
      note(false, 'gateway reachable', `${baseUrl} — ${error.message}`)
    }
  } else {
    note(false, 'gateway reachable', 'no port or key recorded yet')
  }

  process.stdout.write(`${PRODUCT} doctor\n\n`)
  for (const row of results) {
    process.stdout.write(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.label}\n        ${row.detail}\n`)
  }
  const failed = results.filter(row => !row.ok).length
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed.\n`)
  if (failed > 0) process.exitCode = 1
}

function cmdUninstall() {
  const file = path.join(codexHome(), 'config.toml')
  const contents = readConfig(file)
  if (!contents.includes(BEGIN)) {
    process.stdout.write('Nothing to remove; config.toml has no managed block.\n')
    return
  }
  writeConfig(file, stripManagedBlock(contents))
  process.stdout.write(`Removed the ${PROVIDER_ID} provider block from ${file}\n`)
  process.stdout.write(`Settings were left at ${resolveDataDir()} — delete that directory to remove them too.\n`)
}

const USAGE = `${PRODUCT} ${VERSION}

  cofm setup [--port N] [--no-config]   Start the gateway and wire Codex to it
  cofm run [--port N]                   Start the gateway only
  cofm doctor                           Check the install end to end
  cofm uninstall                        Remove the provider block from config.toml

Environment:
  COFM_HOME   data directory (default: $CODEX_HOME/our-free-model)
  CODEX_HOME  where config.toml lives (default: ~/.codex)
`

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (command === 'setup') return cmdSetup(argv)
  if (command === 'run') return cmdRun(argv)
  if (command === 'doctor') return cmdDoctor()
  if (command === 'uninstall') return cmdUninstall()
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
  process.exitCode = 1
}

// Only act when run as a program: importing this module for its helpers (the
// tests do) must not start a gateway or touch the user's config.
const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}