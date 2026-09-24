import type { SubtitleProject, SubtitleTrack } from '@sublight/core'

/**
 * IndexedDB persistence for player projects (Spec 02 §5, ADR-0014).
 * Single DB `sublight-projects`, stores:
 * - `projects`  — one JSON document per project (keyPath `id`);
 * - `tracks`    — one row per track (keyPath `id`, index `projectId`),
 *   so cue-heavy projects stay blob-friendly and future migrations are cheap;
 * - `settings`  — small generic key/value rows (opened file handles, app prefs).
 *
 * Schema versioning from day one: bump `DB_VERSION` and extend the `upgrades`
 * map with a function for each version (per ADR-0014 "migrations planned").
 */

export const DB_NAME = 'sublight-projects'
export const DB_VERSION = 1
export const PROJECTS_STORE = 'projects'
export const TRACKS_STORE = 'tracks'
export const SETTINGS_STORE = 'settings'

type Upgrader = (db: IDBDatabase, oldVersion: number) => void

const upgrades: Record<number, Upgrader> = {
  1: (db) => {
    if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
      db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains(TRACKS_STORE)) {
      const store = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' })
      store.createIndex('projectId', 'projectId', { unique: false })
    }
    if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
      db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
    }
  },
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      const from = (ev as IDBVersionChangeEvent).oldVersion
      for (let v = from + 1; v <= DB_VERSION; v++) upgrades[v]?.(db, from)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`open ${DB_NAME} failed`))
  })
  return dbPromise
}

// TEST ONLY: forget the cached connection so tests can re-create the schema.
export function __resetDbForTests(): void {
  void dbPromise?.then((db) => db.close())
  dbPromise = null
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const req = fn(tx.objectStore(storeName))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`${storeName} request failed`))
  })
}

/** Persist a project as one `projects` row + one row per track. */
export async function saveProject(project: SubtitleProject): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([PROJECTS_STORE, TRACKS_STORE], 'readwrite')
    t.objectStore(PROJECTS_STORE).put({ ...project })
    const tracks = t.objectStore(TRACKS_STORE)
    const index = tracks.index('projectId')
    // Replace this project's old rows, then write the current set.
    const keysReq = index.getAllKeys(project.id)
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) tracks.delete(key)
      for (const track of project.tracks) tracks.put({ ...track })
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('saveProject transaction failed'))
  })
}

export async function loadProject(id: string): Promise<SubtitleProject | null> {
  const db = await openDb()
  const project = (await tx(db, PROJECTS_STORE, 'readonly', (s) => s.get(id))) as
    SubtitleProject | undefined
  if (!project) return null
  const tracks = (await tx(db, TRACKS_STORE, 'readonly', (s) =>
    s.index('projectId').getAll(id),
  )) as SubtitleTrack[]
  return { ...project, tracks: tracks.sort((a, b) => a.createdAt - b.createdAt) }
}

/** All projects (recents include full tracks — local scale). */
export async function listProjects(): Promise<SubtitleProject[]> {
  const db = await openDb()
  const rows = (await tx(db, PROJECTS_STORE, 'readonly', (s) => s.getAll())) as SubtitleProject[]
  const projects = await Promise.all(rows.map((p) => loadProject(p.id)))
  return projects
    .filter((p): p is SubtitleProject => p !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([PROJECTS_STORE, TRACKS_STORE], 'readwrite')
    t.objectStore(PROJECTS_STORE).delete(id)
    const tracks = t.objectStore(TRACKS_STORE)
    const keysReq = tracks.index('projectId').getAllKeys(id)
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) tracks.delete(key)
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('deleteProject transaction failed'))
  })
}

// --- settings (generic small JSON rows) ---

export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await openDb()
  const row = (await tx(db, SETTINGS_STORE, 'readonly', (s) => s.get(key))) as
    { key: string; value: T } | undefined
  return row?.value ?? null
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDb()
  await tx(db, SETTINGS_STORE, 'readwrite', (s) => s.put({ key, value }))
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await openDb()
  await tx(db, SETTINGS_STORE, 'readwrite', (s) => s.delete(key))
}
