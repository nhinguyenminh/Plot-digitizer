import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOnlineLearningConfig, syncOnlineLearning } from '../src/lib/online-learning.ts'
import { initialInteractionModel } from '../src/lib/interaction-learning.ts'

const config = { url: 'https://example.supabase.co', key: 'sb_publishable_test' }
const model = { version: 1, weights: [-4, 0, 8, 0, 0, 0, 0, 0, 0], samples: 1 }
const pointSpacingModel = { version: 1, factor: 1.1, samples: 3 }
const interactionModel = {
  ...initialInteractionModel(),
  featureSamples: 2,
  spacingFactor: 0.94,
  spacingSamples: 1,
  snapRadius: 12.5,
  snapSamples: 1,
  stats: { pointsAdded: 2, pointsMoved: 1, pointsDeleted: 0, pointsSnapped: 3, healingApplied: 1, paintSessions: 0, reconstructionEdits: 0 },
}
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
    async savePointSpacingModel() {},
    async saveInteractionModel() {},
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 2) throw new Error('offline')
    if (url.endsWith('/plotline_get_point_spacing_model')) return Response.json(pointSpacingModel)
    if (url.endsWith('/plotline_get_interaction_model')) return Response.json(interactionModel)
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
    assert.deepEqual(result.pointSpacingModel, pointSpacingModel)
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
    async savePointSpacingModel() {},
    async saveInteractionModel() {},
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/plotline_submit_curve_comparison')) {
      assert.deepEqual(JSON.parse(options.body), { p_id: item.updateId, p_delta: item.delta, p_comparison: comparison })
      return Response.json(model)
    }
    if (url.endsWith('/plotline_get_interaction_model')) return Response.json(interactionModel)
    return Response.json(pointSpacingModel)
  }
  try { assert.equal((await syncOnlineLearning(store, config)).pending, 0) }
  finally { globalThis.fetch = originalFetch }
})

test('submits only a numeric spacing target and acknowledges it with the shared model', async () => {
  const item = { id: 'spacing-sample', updateId: 'spacing-uuid', delta: [], spacingTarget: 1.15, status: 'pending' }
  let acknowledged = false
  const store = {
    async pendingSamples() { return acknowledged ? [] : [item] },
    async acknowledgePointSpacing(id, receivedModel) {
      assert.equal(id, item.id)
      assert.deepEqual(receivedModel, pointSpacingModel)
      acknowledged = true
    },
    async cacheModel(receivedModel) { assert.deepEqual(receivedModel, model) },
    async savePointSpacingModel(receivedModel) { assert.deepEqual(receivedModel, pointSpacingModel) },
    async saveInteractionModel(receivedModel) { assert.deepEqual(receivedModel, interactionModel) },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/plotline_submit_point_spacing_update')) {
      assert.deepEqual(JSON.parse(options.body), { p_id: item.updateId, p_target: item.spacingTarget })
      return Response.json(pointSpacingModel)
    }
    if (url.endsWith('/plotline_get_learning_model')) return Response.json(model)
    if (url.endsWith('/plotline_get_point_spacing_model')) return Response.json(pointSpacingModel)
    if (url.endsWith('/plotline_get_interaction_model')) return Response.json(interactionModel)
    assert.fail(`unexpected learning endpoint: ${url}`)
  }
  try {
    const result = await syncOnlineLearning(store, config)
    assert.equal(result.pending, 0)
    assert.deepEqual(result.pointSpacingModel, pointSpacingModel)
  } finally { globalThis.fetch = originalFetch }
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

test('keeps point-spacing updates queued when the point-spacing migration is missing', async () => {
  const item = { id: 'spacing-sample', updateId: 'spacing-uuid', delta: [], spacingTarget: 1.15, status: 'pending' }
  const store = {
    async pendingSamples() { return [item] },
    async acknowledgePointSpacing() { assert.fail('failed update must remain queued') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 404 })
  try { await assert.rejects(syncOnlineLearning(store, config), /point-spacing-learning\.sql/) }
  finally { globalThis.fetch = originalFetch }
})

test('submits bounded interaction updates and acknowledges them with the shared interaction model', async () => {
  const interactionUpdate = {
    featureDelta: Array(14).fill(0.05),
    featureSamplesDelta: 1,
    spacingTarget: 0.94,
    curvatureDelta: 0.04,
    snapTarget: 12.5,
    healingChoice: 2,
    statsDelta: { pointsAdded: 1, pointsMoved: 0, pointsDeleted: 0, pointsSnapped: 0, healingApplied: 1, paintSessions: 0, reconstructionEdits: 0 },
  }
  const item = { id: 'interaction-sample', updateId: 'interaction-uuid', delta: [], interactionUpdate, status: 'pending' }
  let acknowledged = false
  const store = {
    async pendingSamples() { return acknowledged ? [] : [item] },
    async acknowledgeInteraction(id, receivedModel) {
      assert.equal(id, item.id)
      assert.deepEqual(receivedModel, interactionModel)
      acknowledged = true
    },
    async cacheModel(receivedModel) { assert.deepEqual(receivedModel, model) },
    async savePointSpacingModel(receivedModel) { assert.deepEqual(receivedModel, pointSpacingModel) },
    async saveInteractionModel() { assert.fail('unexpected separate interaction cache') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/plotline_submit_interaction_update')) {
      assert.deepEqual(JSON.parse(options.body), { p_id: item.updateId, p_update: interactionUpdate })
      return Response.json(interactionModel)
    }
    if (url.endsWith('/plotline_get_learning_model')) return Response.json(model)
    if (url.endsWith('/plotline_get_point_spacing_model')) return Response.json(pointSpacingModel)
    assert.fail(`unexpected endpoint: ${url}`)
  }
  try {
    const result = await syncOnlineLearning(store, config)
    assert.equal(result.pending, 0)
    assert.deepEqual(result.interactionModel, interactionModel)
  } finally { globalThis.fetch = originalFetch }
})

test('keeps interaction updates queued when interaction-learning.sql migration is missing', async () => {
  const item = {
    id: 'interaction-sample',
    updateId: 'interaction-uuid',
    delta: [],
    interactionUpdate: {
      featureDelta: Array(14).fill(0),
      featureSamplesDelta: 0,
      spacingTarget: null,
      curvatureDelta: 0,
      snapTarget: null,
      healingChoice: 1,
      statsDelta: { pointsAdded: 0, pointsMoved: 0, pointsDeleted: 0, pointsSnapped: 0, healingApplied: 1, paintSessions: 0, reconstructionEdits: 0 },
    },
    status: 'pending',
  }
  const store = {
    async pendingSamples() { return [item] },
    async acknowledgeInteraction() { assert.fail('failed update must remain queued') },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 404 })
  try { await assert.rejects(syncOnlineLearning(store, config), /interaction-learning\.sql/) }
  finally { globalThis.fetch = originalFetch }
})
