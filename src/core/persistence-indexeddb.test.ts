import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createDemoProject } from './demo'
import {
  createProjectCheckpoint,
  createProjectPersistence,
  ProjectCheckpointConflictError,
  ProjectDurabilityError,
  ProjectRecoveryPendingError,
  serializeProjectCheckpoint,
} from './persistence'
import type { ProjectCheckpoint } from './persistence'

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()
  private failKey: string | undefined

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) {
    if (this.failKey === key) {
      this.failKey = undefined
      throw new DOMException('Injected quota failure', 'QuotaExceededError')
    }
    this.values.set(key, value)
  }
  failNextSet(key: string) { this.failKey = key }
}

const unavailableIndexedDB = {
  open: () => { throw new DOMException('Injected IndexedDB open failure', 'UnknownError') },
} as unknown as IDBFactory

const seedIndexedCheckpoint = async (
  indexedDB: IDBFactory,
  namespace: string,
  checkpoint: ProjectCheckpoint,
) => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${namespace}-projects`, 2)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('projects')) database.createObjectStore('projects', { keyPath: 'id' })
      if (!database.objectStoreNames.contains('recovery')) database.createObjectStore('recovery', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('projects', 'readwrite')
    transaction.objectStore('projects').put({ id: checkpoint.project.id, checkpoint })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

describe('IndexedDB persistence arbitration', () => {
  it('reopens the newest acknowledged fallback instead of a stale preferred backend', async () => {
    const indexedDB = new IDBFactory()
    const localStorage = new TestStorage()
    const namespace = 'split-brain-newest'
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })

    const preferred = createProjectPersistence({ indexedDB, localStorage, namespace })
    const first = await preferred.saveWorkspace(project, { candidates: [] })
    expect(preferred.getBackend()).toBe('indexeddb')

    project.name = 'Newest acknowledged localStorage fallback'
    project.updatedAt = '2026-07-15T00:00:01.000Z'
    const fallback = createProjectPersistence({ indexedDB: unavailableIndexedDB, localStorage, namespace })
    const second = await fallback.saveWorkspace(project, { candidates: [] })
    expect(fallback.getBackend()).toBe('localstorage')
    expect(second.revision).toBeGreaterThan(first.revision)

    const reopened = createProjectPersistence({ indexedDB, localStorage, namespace })
    await expect(reopened.loadWorkspace(project.id)).resolves.toMatchObject({
      checkpointId: second.checkpointId,
      revision: second.revision,
      project: { name: 'Newest acknowledged localStorage fallback' },
    })
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ id: project.id, name: 'Newest acknowledged localStorage fallback' }),
    ])
    expect(reopened.getBackend()).toBe('localstorage')
  })

  it('suppresses a stale fallback journal when a newer acknowledged primary exists', async () => {
    const indexedDB = new IDBFactory()
    const localStorage = new TestStorage()
    const namespace = 'stale-recovery'
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })

    const local = createProjectPersistence({ indexedDB: null, localStorage, namespace })
    await local.saveWorkspace(project, { candidates: [] })
    project.name = 'Stale interrupted localStorage edit'
    project.updatedAt = '2026-07-15T00:00:01.000Z'
    localStorage.failNextSet(`${namespace}:project:${project.id}`)
    await expect(local.saveWorkspace(project, { candidates: [] }))
      .rejects.toBeInstanceOf(ProjectRecoveryPendingError)

    project.name = 'Newer acknowledged IndexedDB edit'
    project.updatedAt = '2026-07-15T00:00:02.000Z'
    const preferred = createProjectPersistence({ indexedDB, localStorage: null, namespace })
    const newest = await preferred.saveWorkspace(project, { candidates: [] })

    const reopened = createProjectPersistence({ indexedDB, localStorage, namespace })
    await expect(reopened.loadWorkspace(project.id)).resolves.toMatchObject({
      checkpointId: newest.checkpointId,
      project: { name: 'Newer acknowledged IndexedDB edit' },
    })
    await expect(reopened.loadRecovery(project.id)).resolves.toBeUndefined()
    await expect(reopened.listRecoveries()).resolves.toEqual([])
  })

  it('enumerates interrupted saves for projects that have never reached the acknowledged project list', async () => {
    const localStorage = new TestStorage()
    const namespace = 'cross-project-recovery'
    const activeProject = createDemoProject({
      id: 'project-a',
      name: 'Active project A',
      now: '2026-07-15T00:00:00.000Z',
    })
    const interruptedProjectB = createDemoProject({
      id: 'project-b',
      name: 'Interrupted project B',
      now: '2026-07-15T00:00:01.000Z',
    })
    const interruptedProjectC = createDemoProject({
      id: 'project-c',
      name: 'Interrupted project C',
      now: '2026-07-15T00:00:02.000Z',
    })
    const persistence = createProjectPersistence({ indexedDB: null, localStorage, namespace })

    await persistence.saveWorkspace(activeProject, { candidates: [] })
    localStorage.failNextSet(`${namespace}:project:${interruptedProjectB.id}`)
    await expect(persistence.saveWorkspace(interruptedProjectB, { candidates: [] }))
      .rejects.toMatchObject({
        name: 'ProjectRecoveryPendingError',
        projectId: interruptedProjectB.id,
      } satisfies Partial<ProjectRecoveryPendingError>)
    localStorage.failNextSet(`${namespace}:project:${interruptedProjectC.id}`)
    await expect(persistence.saveWorkspace(interruptedProjectC, { candidates: [] }))
      .rejects.toMatchObject({
        name: 'ProjectRecoveryPendingError',
        projectId: interruptedProjectC.id,
      } satisfies Partial<ProjectRecoveryPendingError>)

    const reopened = createProjectPersistence({ indexedDB: null, localStorage, namespace })
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ id: activeProject.id, name: activeProject.name }),
    ])
    const recoveries = await reopened.listRecoveries()
    expect(recoveries.map((checkpoint) => checkpoint.project.id)).toEqual([
      interruptedProjectC.id,
      interruptedProjectB.id,
    ])
    expect(recoveries[0].revision).toBeGreaterThan(recoveries[1].revision)

    await reopened.discardRecovery(interruptedProjectC.id)
    await expect(reopened.listRecoveries()).resolves.toEqual([
      expect.objectContaining({ project: expect.objectContaining({ id: interruptedProjectB.id }) }),
    ])
    await expect(reopened.recover(interruptedProjectB.id)).resolves.toMatchObject({
      project: { id: interruptedProjectB.id, name: interruptedProjectB.name },
    })
    await expect(reopened.listRecoveries()).resolves.toEqual([])
    await expect(reopened.loadWorkspace(interruptedProjectB.id)).resolves.toMatchObject({
      project: { id: interruptedProjectB.id, name: interruptedProjectB.name },
    })
  })

  it('does not report an in-memory fallback as a durable save', async () => {
    const persistence = createProjectPersistence({ indexedDB: null, localStorage: null })
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })

    await expect(persistence.saveWorkspace(project, { candidates: [] })).rejects.toMatchObject({
      name: 'ProjectDurabilityError',
      code: 'durable-storage-unavailable',
      attemptedBackends: ['memory'],
    } satisfies Partial<ProjectDurabilityError>)
    expect(persistence.getBackend()).toBe('memory')
    await expect(persistence.loadWorkspace(project.id)).resolves.toMatchObject({ project: { id: project.id } })
  })

  it('reports quota exhaustion even when an in-memory session copy succeeds', async () => {
    const localStorage = new TestStorage()
    const namespace = 'quota-to-memory'
    const persistence = createProjectPersistence({ indexedDB: null, localStorage, namespace })
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })
    localStorage.failNextSet(`${namespace}:recovery:${project.id}`)

    await expect(persistence.saveWorkspace(project, { candidates: [] })).rejects.toMatchObject({
      name: 'ProjectDurabilityError',
      code: 'quota-exceeded',
      attemptedBackends: ['localstorage', 'memory'],
    } satisfies Partial<ProjectDurabilityError>)
    expect(persistence.getBackend()).toBe('memory')
  })

  it('surfaces equal-revision conflicts instead of choosing a backend silently', async () => {
    const indexedDB = new IDBFactory()
    const localStorage = new TestStorage()
    const namespace = 'equal-revision-conflict'
    const firstProject = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })
    const secondProject = structuredClone(firstProject)
    firstProject.name = 'IndexedDB branch'
    secondProject.name = 'localStorage branch'
    const revision = 1_784_073_600_000_123
    const first = createProjectCheckpoint(firstProject, { candidates: [] }, {
      checkpointId: 'checkpoint-idb-branch',
      revision,
      savedAt: '2026-07-15T00:00:00.000Z',
    })
    const second = createProjectCheckpoint(secondProject, { candidates: [] }, {
      checkpointId: 'checkpoint-localstorage-branch',
      revision,
      savedAt: '2026-07-15T00:00:00.000Z',
    })
    await seedIndexedCheckpoint(indexedDB, namespace, first)
    localStorage.setItem(`${namespace}:project:${second.project.id}`, await serializeProjectCheckpoint(second))

    const persistence = createProjectPersistence({ indexedDB, localStorage, namespace })
    await expect(persistence.loadWorkspace(first.project.id)).rejects.toMatchObject({
      name: 'ProjectCheckpointConflictError',
      projectId: first.project.id,
      revision,
      checkpointIds: ['checkpoint-idb-branch', 'checkpoint-localstorage-branch'],
    } satisfies Partial<ProjectCheckpointConflictError>)
  })
})
