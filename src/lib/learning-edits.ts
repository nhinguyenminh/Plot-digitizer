import type { Correction } from './reconstruct'

export function learningMasksToCorrections(add: Uint8Array, erase: Uint8Array, width: number, height: number): Correction[] {
  if (add.length !== width * height || erase.length !== width * height) throw new Error('Invalid learning mask dimensions.')
  const corrections: Correction[] = []
  for (const [mask, isErase] of [[erase, true], [add, false]] as const) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      const start = x
      while (x + 1 < width && mask[y * width + x + 1]) x++
      corrections.push({
        points: [{ x: start, y }, { x, y }],
        erase: isErase, layer: 'curve', width: isErase ? 1.5 : 1,
      })
    }
  }
  return corrections
}
