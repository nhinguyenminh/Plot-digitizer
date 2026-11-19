export function thinBinaryInk(ink: Uint8Array, width: number, height: number) {
  const get = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : ink[y * width + x]
  const remove: number[] = []
  for (let iteration = 0; iteration < 100; iteration++) {
    let changed = false
    for (let phase = 0; phase < 2; phase++) {
      remove.length = 0
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (!get(x, y)) continue
        const p = [get(x, y - 1), get(x + 1, y - 1), get(x + 1, y), get(x + 1, y + 1),
          get(x, y + 1), get(x - 1, y + 1), get(x - 1, y), get(x - 1, y - 1)]
        const count = p.reduce((sum, value) => sum + value, 0)
        const transitions = p.reduce((sum, value, index) => sum + (value === 0 && p[(index + 1) % 8] === 1 ? 1 : 0), 0)
        if (count < 2 || count > 6 || transitions !== 1) continue
        const [north, , east, , south, , west] = p
        if (phase === 0 ? north * east * south || east * south * west : north * east * west || north * south * west) continue
        remove.push(y * width + x)
      }
      if (remove.length) changed = true
      for (const index of remove) ink[index] = 0
    }
    if (!changed) break
  }
}
