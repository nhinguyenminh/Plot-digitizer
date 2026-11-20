import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOnlineLearningConfig, syncOnlineLearning } from '../src/lib/online-learning.ts'

const config = { url: 'https://example.supabase.co', key: 'sb_publishable_test' }
const model = { version: 1, weights: [-4, 0, 8, 0, 0, 0, 0, 0, 0], samples: 1 }
const sample = (id) => ({ id, updateId: `${id}-uuid`, delta: Array(9).fill(0.1), status: 'pending' })

test('requires a publishable key and a safe project URL', () => {
  assert.equal(readOnlineLearningConfig(undefined, undefined), null)
  assert.deepEqual(readOnlineLearningConfig(config.url, config.key), config)
  assert.throws(() => readOnlineLearningConfig(config.url, 'sb_secret_no'), /publishable/)
  assert.throws(() => readOnlineLearningConfig('http://example.com', config.key), /HTTPS/)
  assert.throws(() => readOnlineLearningConfig('https://example.com/path', config.key), /Invalid/)
})

test('sends only numeric updates, acknowledges successes and retains failures for retry', async () => {
  const queue = [sample('first'), sample('second')]
  const calls = []
  const store = {
    async pendingSamples() { return queue.filter((item) => item.status === 'pending') },
    async acknowledge(id) { queue.find((item) => item.id === id).status = 'sent' },
    async cacheModel() { assert.fail('unexpected cache') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 2) throw new Error('offline')
    return Response.json(model)
  }
  try {
    await assert.rejects(syncOnlineLearning(store, config), /offline/)
    assert.deepEqual(queue.map((item) => item.status), ['sent', 'pending'])
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_id: 'first-uuid', p_delta: Array(9).fill(0.1) })
    assert.equal(calls[0].options.headers.Authorization, undefined)
    const result = await syncOnlineLearning(store, config)
    assert.equal(result.pending, 0)
    assert.equal(JSON.parse(calls[2].options.body).p_id, 'second-uuid')
  } finally { globalThis.fetch = originalFetch }
})

test('rejects invalid server models without acknowledging queued data', async () => {
  const store = {
    async pendingSamples() { return [sample('first')] },
    async acknowledge() { assert.fail('invalid response must not be acknowledged') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ ...model, weights: [1] })
  try { await assert.rejects(syncOnlineLearning(store, config), /invalid learning model/) }
  finally { globalThis.fetch = originalFetch }
})

test('does not send queued updates to a different Supabase project', async () => {
  const store = { async pendingSamples() { return [{ ...sample('first'), target: 'https://other.supabase.co' }] } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { assert.fail('must not send data to another project') }
  try { await assert.rejects(syncOnlineLearning(store, config), /different Supabase project/) }
  finally { globalThis.fetch = originalFetch }
})

test('sends detailed comparison and weight update together before acknowledging', async () => {
  const comparison = { version: 1, width: 10, height: 10, counts: [97, 1, 1, 1], examples: [[1, 1, 0, 0, 0, 0, 0, 0.1, 0.2, 1]] }
  const item = { ...sample('first'), comparison }
  let acknowledged = false
  const store = {
    async pendingSamples() { return acknowledged ? [] : [item] },
    async acknowledge() { acknowledged = true },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.match(url, /plotline_submit_curve_comparison$/)
    assert.deepEqual(JSON.parse(options.body), { p_id: item.updateId, p_delta: item.delta, p_comparison: comparison })
    return Response.json(model)
  }
  try { assert.equal((await syncOnlineLearning(store, config)).pending, 0) }
  finally { globalThis.fetch = originalFetch }
})

test('keeps detailed comparisons queued when the database migration is missing', async () => {
  const item = { ...sample('first'), comparison: { version: 1, width: 1, height: 1, counts: [0, 1, 0, 0], examples: [[1, 1, 0, 0, 0, 0, 0, 0, 0, 1]] } }
  const store = {
    async pendingSamples() { return [item] },
    async acknowledge() { assert.fail('failed update must remain queued') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 404 })
  try { await assert.rejects(syncOnlineLearning(store, config), /curve-comparisons\.sql/) }
  finally { globalThis.fetch = originalFetch }
})
