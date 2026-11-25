import type { SupabaseClient } from '@supabase/supabase-js'

export type CloudProjectRow = { id: string; name: string; updated_at: string }

export const DELETE_CODE_LENGTH = 6

export function generateDeleteConfirmationCode(
  getRandomValues?: (target: Uint32Array) => Uint32Array,
): string {
  const randomSource = getRandomValues
    ?? (typeof globalThis.crypto?.getRandomValues === 'function'
      ? (target: Uint32Array) => globalThis.crypto.getRandomValues(target)
      : null)
  if (randomSource) {
    const limit = 4_294_000_000
    const buffer = new Uint32Array(1)
    let value = limit
    while (value >= limit) {
      randomSource(buffer)
      value = buffer[0]
    }
    return String(value % 1_000_000).padStart(DELETE_CODE_LENGTH, '0')
  }
  return String(Math.floor(Math.random() * 1_000_000)).padStart(DELETE_CODE_LENGTH, '0')
}

export function isValidDeleteConfirmationCode(input: string, expected: string): boolean {
  return /^\d{6}$/.test(expected) && input.replace(/\s+/g, '') === expected
}

export async function writeCloudProject(
  client: SupabaseClient, ownerId: string, name: string, project: object, target?: CloudProjectRow,
): Promise<CloudProjectRow> {
  if (target) {
    const { data, error } = await client.from('plotline_projects')
      .update({ name, project }).eq('id', target.id).eq('updated_at', target.updated_at)
      .select('id,name,updated_at').maybeSingle()
    if (error) throw error
    if (!data) throw new Error('This project changed or was deleted elsewhere. Reopen it before overwriting.')
    return data
  }
  const { data, error } = await client.from('plotline_projects')
    .insert({ name, project, owner_id: ownerId }).select('id,name,updated_at').single()
  if (error) throw error
  return data
}

export async function deleteCloudProject(
  client: SupabaseClient, target: Pick<CloudProjectRow, 'id'>,
): Promise<CloudProjectRow> {
  const { data, error } = await client.from('plotline_projects')
    .delete().eq('id', target.id)
    .select('id,name,updated_at').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('This project was already deleted or could not be found.')
  return data
}
