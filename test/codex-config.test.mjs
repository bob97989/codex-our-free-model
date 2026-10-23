import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  renderManagedBlock,
  setFeature,
  setTopLevelValues,
  stripManagedBlock,
  upsertManagedBlock,
  writeModelCatalog,
  writeProviderConfig,
} from '../src/codex-config.js'

test('the managed provider block round-trips without touching other config', () => {
  const original = 'model = "gpt-test"\n\n[profiles.work]\napproval_policy = "never"\n'
  const block = renderManagedBlock({ baseUrl: 'http://127.0.0.1:1234', key: 'secret' })
  const updated = upsertManagedBlock(original, block)
  assert.match(updated, /model_providers\.our-free-model/)
  assert.match(updated, /profiles\.work/)
  assert.equal(stripManagedBlock(updated), original)
})

test('writeProviderConfig writes only into the selected Codex home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cofm-config-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = writeProviderConfig({
    baseUrl: 'http://127.0.0.1:4567',
    key: 'local-key',
    models: [{
      slug: 'free-model',
      display_name: 'Free Model',
      context_window: 131072,
      max_context_window: 131072,
      visibility: 'list',
    }],
    env: {},
    home,
  })
  assert.equal(file, path.join(home, '.codex', 'config.toml'))
  const contents = fs.readFileSync(file, 'utf8')
  assert.match(contents, /base_url = "http:\/\/127\.0\.0\.1:4567"/)
  assert.match(contents, /Bearer local-key/)
  assert.match(contents, /^model = "free-model"$/m)
  assert.match(contents, /^model_provider = "our-free-model"$/m)
  assert.match(contents, /^model_catalog_json = "our-free-model\/model-catalog\.json"$/m)
  assert.match(contents, /^\[features\]$/m)
  assert.match(contents, /^enable_mcp_apps = true$/m)
  const catalog = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'our-free-model', 'model-catalog.json'), 'utf8'))
  assert.equal(catalog.models[0].slug, 'free-model')
  assert.match(catalog.models[0].base_instructions, /You are Codex/)
})

test('top-level and feature updates preserve existing tables', () => {
  const original = 'model = "old"\nmodel_provider = "custom"\n\n[features]\nfoo = true\n\n[model_providers.old]\nname = "Old"\n'
  let next = setTopLevelValues(original, {
    model: 'new-model',
    model_provider: 'our-free-model',
  })
  next = setFeature(next, 'enable_mcp_apps', true)
  assert.match(next, /^model = "new-model"$/m)
  assert.match(next, /^model_provider = "our-free-model"$/m)
  assert.match(next, /\[features\]\nenable_mcp_apps = true\nfoo = true/)
  assert.match(next, /\[model_providers\.old\]\nname = "Old"/)
})

test('writeModelCatalog stamps missing base instructions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofm-catalog-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = writeModelCatalog(path.join(dir, 'catalog.json'), [{ slug: 'free' }])
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.match(value.models[0].base_instructions, /You are Codex/)
})
