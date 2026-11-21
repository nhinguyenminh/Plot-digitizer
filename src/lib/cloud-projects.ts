import type { SupabaseClient } from '@supabase/supabase-js'

export type CloudProjectRow = { id: string; name: string; updated_at: string }

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
