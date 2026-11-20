export class History<T> {
  private entries: T[]
  private position = 0
  private readonly limit: number

  constructor(initial: T, limit = 30) {
    this.limit = limit
    this.entries = [initial]
  }

  get current() { return this.entries[this.position] }
  get canUndo() { return this.position > 0 }
  get canRedo() { return this.position < this.entries.length - 1 }
  get snapshots(): readonly T[] { return this.entries }

  record(value: T, merge = false) {
    this.entries = this.entries.slice(0, this.position + 1)
    if (merge && this.position > 0) this.entries[this.position] = value
    else {
      this.entries.push(value)
      if (this.entries.length > this.limit) this.entries.shift()
      this.position = this.entries.length - 1
    }
  }

  replace(value: T) { this.entries[this.position] = value }

  undo() {
    if (!this.canUndo) return null
    return this.entries[--this.position]
  }

  redo() {
    if (!this.canRedo) return null
    return this.entries[++this.position]
  }
}
