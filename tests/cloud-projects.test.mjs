import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import {
  deleteCloudProject,
  generateDeleteConfirmationCode,
  isValidDeleteConfirmationCode,
  writeCloudProject,
} from '../src/lib/cloud-projects.ts'

const row = { id: 'project-id', name: 'Plot', updated_at: '2026-01-01T00:00:00.123456+00:00' }
const project = { version: 2, charts: [{ state: { sourceImageUrl: 'data:image/png;base64,abc', datasets: [{ points: [{ x: 1, y: 2 }] }] } }] }

test('creates a project with its owner and complete editable data', async () => {
  let request
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => { request = { url, options }; return Response.json(row) } },
  })
  assert.deepEqual(await writeCloudProject(client, 'owner-id', 'Plot', project), row)
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), { owner_id: 'owner-id', name: 'Plot', project })
})

test('overwrites only the version that was opened and reports conflicts', async () => {
  let request
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => { request = { url: new URL(url), options }; return Response.json([]) } },
  })
  await assert.rejects(writeCloudProject(client, 'owner-id', 'Plot', project, row), /changed or was deleted/)
  assert.equal(request.options.method, 'PATCH')
  assert.equal(request.url.searchParams.get('id'), `eq.${row.id}`)
  assert.equal(request.url.searchParams.get('updated_at'), `eq.${row.updated_at}`)
  assert.deepEqual(JSON.parse(request.options.body), { name: 'Plot', project })
})

test('deletes a cloud project by id and returns the deleted row', async () => {
  let request
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => { request = { url: new URL(url), options }; return Response.json([row]) } },
  })
  assert.deepEqual(await deleteCloudProject(client, row), row)
  assert.equal(request.options.method, 'DELETE')
  assert.equal(request.url.searchParams.get('id'), `eq.${row.id}`)
})

test('reports an error when deleting a cloud project that no longer exists', async () => {
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async () => Response.json([]) },
  })
  await assert.rejects(deleteCloudProject(client, row), /already deleted or could not be found/)
})

test('generates zero-padded 6-digit delete confirmation codes', () => {
  const code = generateDeleteConfirmationCode()
  assert.match(code, /^\d{6}$/)

  const samples = [4_294_500_000, 42]
  let index = 0
  const padded = generateDeleteConfirmationCode((target) => {
    target[0] = samples[index++]
    return target
  })
  assert.equal(padded, '000042')
  assert.equal(index, 2)
})

test('validates 6-digit delete confirmation code matches strictly', () => {
  assert.equal(isValidDeleteConfirmationCode('482915', '482915'), true)
  assert.equal(isValidDeleteConfirmationCode(' 482 915 ', '482915'), true)
  assert.equal(isValidDeleteConfirmationCode('482916', '482915'), false)
  assert.equal(isValidDeleteConfirmationCode('48291', '482915'), false)
  assert.equal(isValidDeleteConfirmationCode('', '482915'), false)
  assert.equal(isValidDeleteConfirmationCode('482915', '48291'), false)
})
