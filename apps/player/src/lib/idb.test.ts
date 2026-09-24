// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE, type SubtitleProject } from '@sublight/core'
import {
  DB_NAME,
  deleteProject,
  deleteSetting,
  getSetting,
  listProjects,
  loadProject,
  openDb,
  saveProject,
  setSetting,
  __resetDbForTests,
} from './idb'

function makeProject(id: string, title: string, updatedAt: number): SubtitleProject {
  return {
    id,
    title,
    media: { kind: 'local-file', source: `${title}.mp4` },
    tracks: [],
    settings: { style: { ...DEFAULT_SUBTITLE_STYLE } },
    updatedAt,
  }
}

async function wipeDb(): Promise<void> {
  __resetDbForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

describe('IndexedDB project store (Spec 02 §5, ADR-0014)', () => {
  beforeEach(async () => {
    await wipeDb()
  })

  it('creates the schema on first open', async () => {
    const db = await openDb()
    expect(db.name).toBe(DB_NAME)
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['projects', 'settings', 'tracks'])
    const tracks = db.transaction('tracks').objectStore('tracks')
    expect(Array.from(tracks.indexNames)).toContain('projectId')
  })

  it('round-trips a project with tracks', async () => {
    const project = makeProject('p1', 'Alpha', 1000)
    project.tracks = [
      {
        id: 't1',
        projectId: 'p1',
        language: 'en',
        kind: 'import',
        cues: [{ id: 'c1', startMs: 0, endMs: 1000, text: 'hi' }],
        createdAt: 10,
      },
    ]
    await saveProject(project)

    const loaded = await loadProject('p1')
    expect(loaded?.title).toBe('Alpha')
    expect(loaded?.tracks).toHaveLength(1)
    expect(loaded?.tracks[0]!.cues[0]!.text).toBe('hi')
  })

  it('replaces old track rows on save (idempotent)', async () => {
    const project = makeProject('p1', 'Alpha', 2000)
    project.tracks = [
      { id: 't1', projectId: 'p1', language: 'en', kind: 'import', cues: [], createdAt: 1 },
    ]
    await saveProject(project)
    project.tracks = [
      { id: 't1', projectId: 'p1', language: 'en', kind: 'import', cues: [], createdAt: 1 },
      { id: 't2', projectId: 'p1', language: 'pt-BR', kind: 'import', cues: [], createdAt: 2 },
    ]
    await saveProject(project)
    const loaded = await loadProject('p1')
    expect(loaded?.tracks.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })

  it('lists projects newest first (recents feed)', async () => {
    await saveProject(makeProject('p-old', 'Old', 100))
    await saveProject(makeProject('p-new', 'New', 900))
    const projects = await listProjects()
    expect(projects.map((p) => p.id)).toEqual(['p-new', 'p-old'])
  })

  it('deletes a project and its tracks', async () => {
    const project = makeProject('p1', 'Gone', 100)
    project.tracks = [
      { id: 't1', projectId: 'p1', language: 'en', kind: 'import', cues: [], createdAt: 1 },
    ]
    await saveProject(project)
    await deleteProject('p1')
    expect(await loadProject('p1')).toBeNull()
    expect((await listProjects()).length).toBe(0)
  })

  it('round-trips generic settings rows', async () => {
    expect(await getSetting('nope')).toBeNull()
    await setSetting('theme', { dark: true })
    await setSetting('file-handle:p1', { kind: 'stub' })
    expect(await getSetting<{ dark: boolean }>('theme')).toEqual({ dark: true })
    await deleteSetting('theme')
    expect(await getSetting('theme')).toBeNull()
  })
})
