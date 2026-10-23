import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startService } from '../src/service.js'

test('the authenticated loopback settings API updates the live catalog', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofm-gateway-'))
  const service = await startService({
    dataDir,
    port: 0,
    refresh: false,
    logger: { warn() {}, info() {}, log() {} },
  })
  t.after(async () => {
    await service.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const unauthorized = await fetch(`${service.url}/panel`)
  assert.equal(unauthorized.status, 401)

  const headers = {
    authorization: `Bearer ${service.key}`,
    'content-type': 'application/json',
  }
  const initial = await fetch(`${service.url}/panel`, { headers })
  assert.equal(initial.status, 200)
  const before = await initial.json()
  assert.ok(Array.isArray(before.models))
  assert.ok(Array.isArray(before.registry))

  const save = await fetch(`${service.url}/panel/providers/save`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providerId: 'anthropic',
      apiKey: 'test-key-1234',
      models: ['claude-sonnet-4-20250514'],
    }),
  })
  assert.equal(save.status, 200)
  const saved = await save.json()
  assert.equal(saved.ok, true)
  assert.equal(saved.snapshot.accounts[0].keyHint, '…1234')
  assert.equal(JSON.stringify(saved.snapshot).includes('test-key-1234'), false)
  assert.ok(saved.snapshot.models.some(row => row.id === 'anthropic/claude-sonnet-4-20250514'))

  const hide = await fetch(`${service.url}/panel/model`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ modelId: 'anthropic/claude-sonnet-4-20250514', enabled: false }),
  })
  assert.equal(hide.status, 200)
  const hidden = await hide.json()
  assert.equal(hidden.snapshot.models.find(row => row.id === 'anthropic/claude-sonnet-4-20250514').enabled, false)

  const catalog = await fetch(`${service.url}/v1/models`, { headers })
  assert.equal(catalog.status, 200)
  const rows = await catalog.json()
  assert.equal(rows.data.some(row => row.id === 'anthropic/claude-sonnet-4-20250514'), false)
})
