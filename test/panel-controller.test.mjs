import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createModelRuntime, createRuntimeStores } from '../src/core/runtime.js'
import { createPanelController } from '../src/panel-controller.js'

function makeController() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofm-panel-'))
  const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
  const runtime = createModelRuntime({
    ...stores,
    logger: { warn() {}, info() {} },
    attributionUserAgent: 'test',
  })
  const panel = createPanelController({
    settings: stores.settings,
    runtime,
    version: 'test',
    logger: { warn() {} },
  })
  return {
    dataDir,
    stores,
    runtime,
    panel,
    close() {
      runtime.dispose()
      stores.dispose()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('panel stores accounts without exposing their keys and rebuilds the catalog', t => {
  const fixture = makeController()
  t.after(() => fixture.close())

  const saved = fixture.panel.saveProvider({
    providerId: 'anthropic',
    enabled: true,
    apiKey: 'sk-ant-test-12345678',
    models: ['claude-sonnet-4-20250514'],
  })

  const account = saved.accounts.find(row => row.providerId === 'anthropic')
  assert.ok(account)
  assert.equal(account.enabled, true)
  assert.equal(account.hasKey, true)
  assert.equal(account.keyHint, '…5678')
  assert.equal(account.models.length, 1)
  assert.equal(JSON.stringify(saved).includes('sk-ant-test-12345678'), false)
  assert.ok(saved.models.some(row => row.id === 'anthropic/claude-sonnet-4-20250514'))

  const disk = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'settings.json'), 'utf8'))
  assert.equal(disk.aggregate.providers.anthropic.apiKey, 'sk-ant-test-12345678')
})

test('model switches persist while preserving account configuration', t => {
  const fixture = makeController()
  t.after(() => fixture.close())

  const saved = fixture.panel.saveProvider({
    providerId: 'anthropic',
    apiKey: 'test-key-abcdefgh',
  })
  const model = saved.models.find(row => row.id === 'anthropic/claude-sonnet-4-20250514')
  assert.ok(model)

  const hidden = fixture.panel.setModelEnabled({ modelId: model.id, enabled: false })
  assert.equal(hidden.models.find(row => row.id === model.id).enabled, false)
  assert.ok(hidden.settings.hiddenModelIds.includes(model.id))
  assert.equal(hidden.accounts.find(row => row.providerId === 'anthropic').hasKey, true)

  const visible = fixture.panel.setModelEnabled({ modelId: model.id, enabled: true })
  assert.equal(visible.models.find(row => row.id === model.id).enabled, true)
  assert.equal(visible.settings.hiddenModelIds.includes(model.id), false)
})

test('removing an account also removes its models from the picker', t => {
  const fixture = makeController()
  t.after(() => fixture.close())

  fixture.panel.saveProvider({ providerId: 'anthropic', apiKey: 'test-key' })
  const removed = fixture.panel.removeProvider('anthropic')
  assert.equal(removed.accounts.length, 0)
  assert.equal(removed.models.some(row => row.providerId === 'anthropic'), false)
})

test('ownership-only providers are rejected with an actionable message', t => {
  const fixture = makeController()
  t.after(() => fixture.close())

  const oauthProvider = fixture.panel.snapshot().registry.find(row => row.authKind === 'oauth')
  assert.ok(oauthProvider)
  assert.throws(
    () => fixture.panel.saveProvider({ providerId: oauthProvider.id, apiKey: 'unused' }),
    /aggregate lane only stores API keys/,
  )
})
