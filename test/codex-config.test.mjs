import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  renderManagedBlock,
  stripManagedBlock,
  upsertManagedBlock,
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
    env: {},
    home,
  })
  assert.equal(file, path.join(home, '.codex', 'config.toml'))
  const contents = fs.readFileSync(file, 'utf8')
  assert.match(contents, /base_url = "http:\/\/127\.0\.0\.1:4567"/)
  assert.match(contents, /Bearer local-key/)
})
