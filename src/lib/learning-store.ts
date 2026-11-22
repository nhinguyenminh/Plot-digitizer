import { initialLearningModel } from './learning'
import type { CurveComparison, LearningModel } from './learning'
import { initialPointSpacingModel } from './point-spacing'
import type { PointSpacingModel } from './point-spacing'
import { initialInteractionModel, isValidInteractionModel } from './interaction-learning'
import type { InteractionModel } from './interaction-learning'

export interface TrainingSample {
  id: string
  createdAt: string
  delta: number[]
  updateId?: string
  status?: 'pending' | 'sent'
  target?: string
  comparison?: CurveComparison
  spacingTarget?: number
}

export interface LearningState {
  enabled: boolean
  model: LearningModel
}

export interface LearningStore {
  load(): Promise<LearningState>
  loadPointSpacingModel(): Promise<PointSpacingModel>
  savePointSpacingModel(model: PointSpacingModel): Promise<void>
  savePointSpacingSamples(samples: TrainingSample[], model: PointSpacingModel): Promise<void>
  acknowledgePointSpacing(id: string, model: PointSpacingModel): Promise<void>
  loadInteractionModel(): Promise<InteractionModel>
  saveInteractionModel(model: InteractionModel): Promise<void>
  hasSample(id: string): Promise<boolean>
  saveSample(sample: TrainingSample, model: LearningModel): Promise<void>
  pendingSamples(): Promise<TrainingSample[]>
  acknowledge(id: string, model: LearningModel): Promise<void>
  cacheModel(model: LearningModel): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  clear(): Promise<void>
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('plotline-local-learning', 2)
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('settings')
        request.result.createObjectStore('samples', { keyPath: 'id' })
      }
      request.transaction!.objectStore('samples').createIndex('status', 'status')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local learning storage.'))
    request.onblocked = () => reject(new Error('Local learning storage is blocked by another window.'))
  })
}

export function createLocalLearningStore(): LearningStore {
  const database = openDatabase()
  const transaction = async <T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>) => {
    const db = await database
    const tx = db.transaction(stores, mode)
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Local learning storage transaction was aborted.'))
      tx.onerror = () => reject(tx.error ?? new Error('Could not write local learning data.'))
    })
    const [result] = await Promise.all([work(tx), completed])
    return result
  }
  const get = <T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> => new Promise((resolve, reject) => {
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error ?? new Error('Could not read local learning data.'))
  })
  return {
    async load() {
      return transaction(['settings'], 'readonly', async (tx) => {
        const settings = tx.objectStore('settings')
        const [enabled, model] = await Promise.all([get<boolean>(settings, 'enabled'), get<LearningModel>(settings, 'model')])
        if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid local learning setting.')
        if (model && (model.version !== 1 || !Array.isArray(model.weights) || model.weights.length !== 9
          || !model.weights.every(Number.isFinite) || !Number.isInteger(model.samples) || model.samples < 0)) throw new Error('Invalid local learning model.')
        return { enabled: enabled ?? true, model: model ?? initialLearningModel() }
      })
    },
    async acknowledgePointSpacing(id, model) {
      if (model.version !== 1 || !Number.isInteger(model.samples) || model.samples < 0
        || !Number.isFinite(model.factor) || model.factor < 1 || model.factor > 1.2) {
        throw new Error('Invalid online point-spacing model.')
      }
      await transaction(['samples', 'settings'], 'readwrite', async (tx) => {
        const samples = tx.objectStore('samples')
        const sample = await get<TrainingSample>(samples, id)
        if (!sample?.spacingTarget) throw new Error('The pending point-spacing update no longer exists.')
        samples.put({ ...sample, status: 'sent' })
        tx.objectStore('settings').put(model, 'point-spacing-model')
      })
    },
    async loadPointSpacingModel() {
      return transaction(['settings'], 'readonly', async (tx) => {
        const model = await get<PointSpacingModel>(tx.objectStore('settings'), 'point-spacing-model')
        if (!model) return initialPointSpacingModel()
        if (model.version !== 1 || !Number.isInteger(model.samples) || model.samples < 0
          || !Number.isFinite(model.factor) || model.factor < 1 || model.factor > 1.2) {
          throw new Error('Invalid local point-spacing model.')
        }
        return model
      })
    },
    async savePointSpacingModel(model) {
      if (model.version !== 1 || !Number.isInteger(model.samples) || model.samples < 0
        || !Number.isFinite(model.factor) || model.factor < 1 || model.factor > 1.2) {
        throw new Error('Invalid local point-spacing model.')
      }
      await transaction(['settings'], 'readwrite', async (tx) => {
        tx.objectStore('settings').put(model, 'point-spacing-model')
      })
    },
    async savePointSpacingSamples(samples, model) {
      if (model.version !== 1 || !Number.isInteger(model.samples) || model.samples < 0
        || !Number.isFinite(model.factor) || model.factor < 1 || model.factor > 1.2
        || samples.some((sample) => !sample.updateId || !Number.isFinite(sample.spacingTarget)
          || (sample.spacingTarget ?? 0) < 1.05 || (sample.spacingTarget ?? 2) > 1.2)) {
        throw new Error('Invalid point-spacing learning update.')
      }
      await transaction(['samples', 'settings'], 'readwrite', async (tx) => {
        const store = tx.objectStore('samples')
        for (const sample of samples) store.add(sample)
        tx.objectStore('settings').put(model, 'point-spacing-model')
      })
    },
    async loadInteractionModel() {
      return transaction(['settings'], 'readonly', async (tx) => {
        const model = await get<InteractionModel>(tx.objectStore('settings'), 'interaction-model')
        if (!model) return initialInteractionModel()
        if (!isValidInteractionModel(model)) throw new Error('Invalid local interaction learning model.')
        return model
      })
    },
    async saveInteractionModel(model) {
      if (!isValidInteractionModel(model)) throw new Error('Invalid local interaction learning model.')
      await transaction(['settings'], 'readwrite', async (tx) => {
        tx.objectStore('settings').put(model, 'interaction-model')
      })
    },
    async saveSample(sample, model) {
      await transaction(['samples', 'settings'], 'readwrite', async (tx) => {
        tx.objectStore('samples').add(sample)
        tx.objectStore('settings').put(model, 'model')
      })
    },
    async hasSample(id) {
      return transaction(['samples'], 'readonly', async (tx) => (await get<TrainingSample>(tx.objectStore('samples'), id)) !== undefined)
    },
    async pendingSamples() {
      return transaction(['samples'], 'readonly', (tx) => new Promise<TrainingSample[]>((resolve, reject) => {
        const request = tx.objectStore('samples').index('status').getAll('pending')
        request.onsuccess = () => resolve(request.result as TrainingSample[])
        request.onerror = () => reject(request.error ?? new Error('Could not read local training samples.'))
      }))
    },
    async acknowledge(id, model) {
      await transaction(['samples', 'settings'], 'readwrite', async (tx) => {
        const samples = tx.objectStore('samples')
        const sample = await get<TrainingSample>(samples, id)
        if (!sample) throw new Error('The pending learning update no longer exists.')
        samples.put({ ...sample, status: 'sent' })
        tx.objectStore('settings').put(model, 'model')
      })
    },
    async cacheModel(model) {
      await transaction(['settings'], 'readwrite', async (tx) => { tx.objectStore('settings').put(model, 'model') })
    },
    async setEnabled(enabled) {
      await transaction(['settings'], 'readwrite', async (tx) => { tx.objectStore('settings').put(enabled, 'enabled') })
    },
    async clear() {
      await transaction(['samples', 'settings'], 'readwrite', async (tx) => {
        tx.objectStore('samples').clear()
        tx.objectStore('settings').delete('model')
        tx.objectStore('settings').delete('point-spacing-model')
        tx.objectStore('settings').delete('interaction-model')
      })
    },
  }
}
