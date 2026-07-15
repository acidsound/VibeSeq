import { useCallback, useEffect, useRef, useState } from 'react'
import { assertProjectArrangementInvariants, createBlankProject, createHistoryStore, createSnapshotCommand, normalizeProjectMidiTracks } from '../core'
import type { HistorySnapshot, HistoryStore } from '../core'
import type { Project } from '../types'

export type ProjectMutator = (draft: Project) => void

export interface ProjectMutationError {
  label: string
  message: string
  cause: unknown
}

const cloneProject = (project: Project): Project => structuredClone(project)

/** Keep non-musical runtime truth when a musical snapshot moves through history. */
export const preserveProjectOperationalState = (historical: Project, current: Project): Project => {
  historical.jobs = structuredClone(current.jobs)
  const currentAssets = new Map(current.assets.map((asset) => [asset.id, asset]))
  for (const asset of historical.assets) {
    const currentAsset = currentAssets.get(asset.id)
    if (currentAsset?.integrity) asset.integrity = structuredClone(currentAsset.integrity)
    else delete asset.integrity
  }
  historical.updatedAt = new Date().toISOString()
  return historical
}

export function useProjectHistory(initialProject?: Project) {
  const storeRef = useRef<HistoryStore<Project> | null>(null)
  if (!storeRef.current) {
    const initial = cloneProject(initialProject ?? createBlankProject())
    normalizeProjectMidiTracks(initial)
    storeRef.current = createHistoryStore(initial)
  }
  const store = storeRef.current
  const [snapshot, setSnapshot] = useState<HistorySnapshot<Project>>(
    () => store.getSnapshot(),
  )
  const [mutationError, setMutationError] = useState<ProjectMutationError | null>(null)

  useEffect(() => store.subscribe(setSnapshot), [store])

  const mutate = useCallback((label: string, recipe: ProjectMutator, mergeKey?: string): Promise<void> => {
    setMutationError(null)
    const execution = store.execute(createSnapshotCommand(label, (state) => {
      const draft = cloneProject(state)
      normalizeProjectMidiTracks(draft)
      recipe(draft)
      assertProjectArrangementInvariants(draft)
      draft.updatedAt = new Date().toISOString()
      return draft
    }, cloneProject, mergeKey, preserveProjectOperationalState)).then(() => undefined)
    // Observe every failure so fire-and-forget UI edits cannot become unhandled
    // promise rejections. Awaited callers still receive this same rejection.
    void execution.catch((cause: unknown) => {
      setMutationError({
        label,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
    })
    return execution
  }, [store])

  const replace = useCallback((project: Project, clearHistory = false) => {
    const normalized = cloneProject(project)
    normalizeProjectMidiTracks(normalized)
    store.replaceState(normalized, { clearHistory })
  }, [store])

  const updateOperational = useCallback((recipe: ProjectMutator): Promise<void> => {
    return store.updateState((state) => {
      const draft = cloneProject(state)
      recipe(draft)
      draft.updatedAt = new Date().toISOString()
      return draft
    }).then(() => undefined)
  }, [store])

  const clearMutationError = useCallback(() => setMutationError(null), [])

  return {
    project: snapshot.state,
    getCurrentProject: () => store.getState(),
    mutate,
    replace,
    updateOperational,
    undo: () => store.undo(),
    redo: () => store.redo(),
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    undoLabel: snapshot.undoLabel,
    redoLabel: snapshot.redoLabel,
    pending: snapshot.pending,
    mutationError,
    clearMutationError,
  }
}
