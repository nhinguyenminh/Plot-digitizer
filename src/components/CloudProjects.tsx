import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import type { Session } from '@supabase/supabase-js'
import { readOnlineLearningConfig } from '../lib/online-learning'
import { writeCloudProject } from '../lib/cloud-projects'
import type { CloudProjectRow } from '../lib/cloud-projects'

type Props = {
  open: boolean
  onClose: () => void
  name: string
  resetKey: number
  saveProject: (name: string, save: (project: object) => Promise<void>) => Promise<boolean>
  openProject: (project: unknown) => Promise<boolean>
}

const configuration = (() => {
  try {
    const config = readOnlineLearningConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)
    return { client: config ? createClient(config.url, config.key) : null, error: config ? '' : 'Configure the Supabase URL and publishable key first.' }
  } catch (error) {
    return { client: null, error: error instanceof Error ? error.message : 'Invalid Supabase configuration.' }
  }
})()

export default function CloudProjects({ open, onClose, name, resetKey, saveProject, openProject }: Props) {
  const client = configuration.client
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [projects, setProjects] = useState<CloudProjectRow[]>([])
  const [current, setCurrent] = useState<CloudProjectRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [copyName, setCopyName] = useState<string | null>(null)
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { previous?.focus() }
  }, [open])

  useEffect(() => {
    if (!client) return
    let active = true
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) setMessage(error.message)
      else setSession(data.session)
    })
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next)
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [client])

  useEffect(() => { setCurrent(null); setProjects([]) }, [session?.user.id, resetKey])

  const listProjects = async () => {
    if (!client) throw new Error('Supabase is not configured.')
    const { data, error } = await client.from('plotline_projects').select('id,name,updated_at').order('updated_at', { ascending: false })
    if (error) throw error
    setProjects(data)
    return data as CloudProjectRow[]
  }

  useEffect(() => {
    if (!open || !session || !client) return
    let active = true
    void client.from('plotline_projects').select('id,name,updated_at').order('updated_at', { ascending: false }).then(({ data, error }) => {
      if (!active) return
      if (error) setMessage(error.message)
      else setProjects(data)
    })
    return () => { active = false }
  }, [open, session?.user.id, client])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await action() }
    catch (error) {
      setMessage(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Cloud operation failed.')
    }
    finally { setBusy(false) }
  }

  const authenticate = (signup: boolean) => run(async () => {
    if (!client) throw new Error('Supabase is not configured.')
    const { data, error } = signup
      ? await client.auth.signUp({ email, password })
      : await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    setPassword('')
    if (signup && !data.session) setMessage('Check your email to confirm your account, then sign in.')
  })

  const save = (saveAs: boolean, requested: string) => run(async () => {
    if (!client || !session) throw new Error('Sign in before saving.')
    const projectName = requested.trim()
    if (!projectName || projectName.length > 200) throw new Error('Project name must contain 1–200 characters.')
    const rows = await listProjects()
    const target = saveAs || !current ? rows.find((row) => row.name === projectName) : current
    if (target && !window.confirm(`Overwrite cloud project "${target.name}"? This replaces its saved data.`)) return
    const saved = await saveProject(projectName, async (project) => {
      setCurrent(await writeCloudProject(client, session.user.id, projectName, project, target))
    })
    if (saved) {
      setCopyName(null)
      setMessage(`Saved "${projectName}" to your account.`)
      try { await listProjects() }
      catch (error) {
        const detail = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Unknown error'
        setMessage(`Saved "${projectName}", but could not refresh the project list: ${detail}`)
      }
    }
  })

  const load = (row: CloudProjectRow) => run(async () => {
    if (!client) throw new Error('Supabase is not configured.')
    if (!window.confirm(`Open "${row.name}"? The current workspace will be replaced; save it first if needed.`)) return
    const { data, error } = await client.from('plotline_projects').select('id,name,updated_at,project').eq('id', row.id).single()
    if (error) throw error
    if (await openProject(data.project)) {
      setCurrent({ id: data.id, name: data.name, updated_at: data.updated_at })
      setMessage(`Opened "${data.name}".`)
      onClose()
    }
  })

  if (!open) return null
  return <div className="cloud-overlay">
    <section ref={dialog} className="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
      if (!focusable.length) { event.preventDefault(); return }
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus() }
      else if (!event.shiftKey && (index === -1 || index === focusable.length - 1)) { event.preventDefault(); focusable[0].focus() }
    }}>
      <div className="cloud-heading"><h2 id="cloud-title">Cloud projects</h2><button onClick={onClose} disabled={busy} aria-label="Close cloud projects">×</button></div>
      {configuration.error && <p role="alert">{configuration.error}</p>}
      {client && !session && <form onSubmit={(event) => { event.preventDefault(); void authenticate(false) }}>
        <p>Sign in to access your private projects.</p>
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="cloud-actions"><button disabled={busy} type="submit">Sign in</button><button disabled={busy || !email || !password} type="button" onClick={() => void authenticate(true)}>Create account</button></div>
      </form>}
      {client && session && <>
        <p>Signed in as {session.user.email}</p>
        <div className="cloud-actions">
          <button disabled={busy} onClick={() => void save(false, name)}>Save{current ? `: ${current.name}` : ''}</button>
          <button disabled={busy} onClick={() => setCopyName(name)}>Save as</button>
          <button disabled={busy} onClick={() => void run(async () => { const { error } = await client.auth.signOut(); if (error) throw error })}>Sign out</button>
        </div>
        {copyName !== null && <form onSubmit={(event) => { event.preventDefault(); void save(true, copyName) }}>
          <label>New project name<input autoFocus maxLength={200} required value={copyName} onChange={(event) => setCopyName(event.target.value)} /></label>
          <div className="cloud-actions"><button disabled={busy} type="submit">Save copy</button><button disabled={busy} type="button" onClick={() => setCopyName(null)}>Cancel</button></div>
        </form>}
        <h3>Open a project</h3>
        <div className="cloud-list">{projects.length ? projects.map((project) => <button key={project.id} disabled={busy} onClick={() => void load(project)}><span>{project.name}</span><small>{new Date(project.updated_at).toLocaleString()}</small></button>) : <p>No saved projects.</p>}</div>
      </>}
      {message && <p role="status" className="cloud-message">{message}</p>}
    </section>
  </div>
}
