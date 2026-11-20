import type { LearningModel } from './learning'
import type { LearningStore } from './learning-store'
import type { PointSpacingModel } from './point-spacing'

export interface OnlineLearningConfig { url: string; key: string }

export function readOnlineLearningConfig(url: string | undefined, key: string | undefined): OnlineLearningConfig | null {
  if (!url && !key) return null
  if (!url || !key) throw new Error('Both the Supabase URL and publishable key are required.')
  if (!key.startsWith('sb_publishable_')) throw new Error('Use a Supabase publishable key, not a secret or legacy key.')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('The Supabase URL must use HTTPS.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Invalid Supabase project URL.')
  return { url: parsed.origin, key }
}

function validModel(value: unknown): value is LearningModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<LearningModel>
  return model.version === 1 && Array.isArray(model.weights) && model.weights.length === 9
    && model.weights.every((weight) => Number.isFinite(weight) && Math.abs(weight) <= 16)
    && Number.isInteger(model.samples) && (model.samples ?? -1) >= 0
}

export async function callLearningRpc(config: OnlineLearningConfig, name: string, args: object): Promise<LearningModel> {
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Supabase learning request failed (HTTP ${response.status}).${name === 'plotline_submit_curve_comparison' && response.status === 404 ? ' Apply supabase/curve-comparisons.sql in the Supabase SQL editor.' : ''}`)
  const model: unknown = await response.json()
  if (!validModel(model)) throw new Error('Supabase returned an invalid learning model.')
  return model
}

function validPointSpacingModel(value: unknown): value is PointSpacingModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<PointSpacingModel>
  return model.version === 1 && Number.isInteger(model.samples) && (model.samples ?? -1) >= 0
    && Number.isFinite(model.factor) && (model.factor ?? 0) >= 1 && (model.factor ?? 2) <= 1.2
}

export async function callPointSpacingRpc(config: OnlineLearningConfig, name: string, args: object): Promise<PointSpacingModel> {
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Supabase point-spacing request failed (HTTP ${response.status}).${response.status === 404 ? ' Apply supabase/point-spacing-learning.sql in the Supabase SQL editor.' : ''}`)
  const model: unknown = await response.json()
  if (!validPointSpacingModel(model)) throw new Error('Supabase returned an invalid point-spacing model.')
  return model
}

export async function syncOnlineLearning(store: LearningStore, config: OnlineLearningConfig): Promise<{ model: LearningModel; pointSpacingModel: PointSpacingModel; pending: number }> {
  const pending = await store.pendingSamples()
  let model: LearningModel | null = null
  let pointSpacingModel: PointSpacingModel | null = null
  for (const sample of pending) {
    if (!sample.updateId) throw new Error('Invalid queued learning update.')
    if (sample.target && sample.target !== config.url) throw new Error('A queued update belongs to a different Supabase project.')
    if (sample.spacingTarget !== undefined) {
      if (!Number.isFinite(sample.spacingTarget) || sample.spacingTarget < 1.05 || sample.spacingTarget > 1.2) throw new Error('Invalid queued point-spacing update.')
      pointSpacingModel = await callPointSpacingRpc(config, 'plotline_submit_point_spacing_update', { p_id: sample.updateId, p_target: sample.spacingTarget })
      await store.acknowledgePointSpacing(sample.id, pointSpacingModel)
    } else {
      if (sample.delta.length !== 9 || !sample.delta.every((n) => Number.isFinite(n) && Math.abs(n) <= 0.5)) throw new Error('Invalid queued learning update.')
      model = sample.comparison
        ? await callLearningRpc(config, 'plotline_submit_curve_comparison', { p_id: sample.updateId, p_delta: sample.delta, p_comparison: sample.comparison })
        : await callLearningRpc(config, 'plotline_submit_learning_update', { p_id: sample.updateId, p_delta: sample.delta })
      await store.acknowledge(sample.id, model)
    }
  }
  if (!model) {
    model = await callLearningRpc(config, 'plotline_get_learning_model', {})
    await store.cacheModel(model)
  }
  if (!pointSpacingModel) {
    pointSpacingModel = await callPointSpacingRpc(config, 'plotline_get_point_spacing_model', {})
    await store.savePointSpacingModel(pointSpacingModel)
  }
  return { model, pointSpacingModel, pending: (await store.pendingSamples()).length }
}
